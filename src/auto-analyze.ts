import { LLMCallFunc, LLMCompatibleMessage } from './types';
import fs from 'fs';
import path from 'path';

// prettier-ignore
const MARKDOWN_TEMPLATE = (inputObj: any, typespec: string, ddlExplanation: string | null, ddl: string | null, structuredDDL: string | null, objectToRow: string | null) =>
`# Automated Object Analysis
*All the key information in this file was generated by an LLM. Treat it as a starting point, don't ever run auto-generated code without a sandbox unless you have checked it yourself.*

The primary intent for this analysis is to go from an object to all the tools you need to use this library. The hardest part is the object-to-relational conversion, of converting a (potentially) nested json into flat tables that can be queried.

We will generate the following things:
1. A typespec - We need good type definition for our incoming object. You might already have this, in which case make sure to provide a string version to the function to treat this as a starting point.
2. DDL - The SQLite table descriptors that can hold the information in the object.
3. Structured DDL - This is an internal type that is used by the library to add additional information - like example values, potential min and max ranges, which fields are visible to the LLM converting natural language to query, etc. Most of this is metadata intended for the library and the LLM, and are stripped out when creating the tables.
4. ObjectToRow - This is ostensibly the hardest function out of the bunch, so treat it as a starting point. It should do the drudge work of writing a function to turn every field in the JSON into a flat string array that sqlite can ingest.

# Typespec

\`\`\`typescript
${typespec}
\`\`\`

${ddl ?
`# SQL Tables
\`\`\`sql
${ddl}
\`\`\`` : ''}

${structuredDDL ?
`# Structured DDL
\`\`\`typescript
${structuredDDL}
\`\`\``
: ''}

${objectToRow ?
`# Object to Rows function
\`\`\`typescript
${objectToRow}
\`\`\``
: ''}

See [Examples] for an example of how to use this code to create an instance of the search engine.

# Appendix

## Input Object

\`\`\`json
${JSON.stringify(inputObj, null, 2)}
\`\`\`

${ddlExplanation ?
`## Reasoning for table structure

${ddlExplanation}`
: ''}
`

// prettier-ignore
const prompts = {
  generateTypespec: {
    system: (inputObj: any) =>
`EXAMPLE_JSON:
\`\`\`
${JSON.stringify(inputObj, null, 2)}
\`\`\``,
    user: `Outline a typespec in typescript for the EXAMPLE provided.`
  },
  tableStructure: {
    user:
`GUIDELINES:
1. Prefer flat tables when necessary, instead of making additional tables.
2. Encode datatypes in the column names when possible.
3. Ignore normalization and avoid junction tables, we're looking for a one-to-many relationship between one main table and multiple sub-tables, repetition is okay.

Talk me through (in markdown) how you would structure one of more Sqlite tables to hold this information following GUIDELINES, inferring things like datatypes, what information is being managed, what decisions you would make, step-by-step. Then outline the overall structure of the tables and which columns would need comments in the final DDL to clear any confusion. Be exhaustive, and explain your decisions. Skip primary keys when they're not really needed.`
  },
  generateDDL: {
    user:
`Please generate the valid Sqlite DDL for me with comments, and place it in sql code blocks.`
  },
  structureDDL: {
    system: (ddl: string) =>
`DDL:
${ddl}`,
    user:
`Convert theDDL into a structure of this typespec:
\`\`\`typescript
export type DDLColumnBase = {
  name: string; // Name of the column
  columnSpec: string; // SQlite type of the column
  staticExamples?: string[]; // Statically provided examples of potential values in the column
  description: string; // Description of the column
  foreignKey?: {
    // Is this a foreign key? which table and column does it connect to? Only one-to-many are allowed.
    table: string;
    column: string;
  };
};

export type DDLColumnMeta = {
  dynamicEnumSettings?: // Settings for generating dynamic enums.
  | {
        type: 'EXHAUSTIVE'; // Provide an exhaustive list of all distinct values.
        topK?: number; // Only save the top K values.
      }
    | {
        type: 'MIN_MAX'; // Provide a minimum and maximum range for the values found.
        format: 'DATE' | 'NUMBER';
      }
    | {
        type: 'EXHAUSTIVE_CHAR_LIMITED';
        charLimit: number; // Total number of characters to limit the output to. Making this a token limit would be better, but it makes us more model dependent and more expensive to compute
      };
  dynamicEnumData?: // Data (generated at runtime) for the enums.
  | {
        type: 'EXAMPLES';
        examples: string[];
      }
    | {
        type: 'MIN_MAX';
        exceptions: string[]; // Exceptions to the range, like null
        min: string;
        max: string;
      };
  visibleToLLM: boolean;
};

export type DDLColumn = DDLColumnBase & DDLColumnMeta;

export type DDLTable = {
  name: string;
  columns: DDLColumn[];
};
\`\`\`

Don't leave any columns out, be exhaustive.`
  },
  objectToRow: {
    system: (typespec: string, ddl: string) =>
`TYPESPEC:
\`\`\`typescript
${typespec}
\`\`\`

DDL:
\`\`\`sql
${ddl}
\`\`\``,
    user: `I need a typescript function called objectToRows to help me insert an object of type TYPESPEC using the sql.js library into tables structured with DDL. The function should take in an array of flight objects like TYPESPEC, and spit out a 3 dimensional string array, with each top level element for each table. Make sure typecast any initial values to prevent errors. Also make sure to check if top-level objects are null before accessing them. Use the Date function to make sure stringified dates are converted back when needed. Make sure none of the values are undefined because we'll insert them later. Use sensible defaults.`
  }
}

/**
 * Provide an example JS object to analyze and an LLM call function from the adapter.
 * This function will generate a markdown with a type specification, SQL table structure,
 * object to relational function, and a structured DDL for use with the library.
 * It will also return the same information as a string array.
 * @param inputObj The object to be analyzed. No arrays.
 * @param callLLM Found when using any adapter in src/llm-adapters.ts
 * @param markdownSaveLocation Where to save the markdown file. If this is not provided, the markdown will not be saved.
 * @param existingTypeSpec If you already have a typespec, provide it here.
 * @returns The typespec, table structure, DDL, structured DDL, and object to relational function as a string array.
 */
export async function autoAnalyzeObject(
  inputObj: any,
  callLLM: LLMCallFunc,
  markdownSaveLocation?: string,
  existingTypeSpec?: string,
) {
  let typespec: string | null = existingTypeSpec ?? null;
  let ddl: string | null = null;
  let structuredDDL: string | null = null;
  let tableStructure: string | null = null;
  let objectToRowFunc: string | null = null;

  const messages: LLMCompatibleMessage[] = [
    {
      role: 'system',
      content: prompts.generateTypespec.system(inputObj),
    },
    {
      role: 'user',
      content: prompts.generateTypespec.user,
    },
  ];

  if (!typespec) {
    console.log('Generating typespec...');

    if (!typespec)
      throw new Error('No response from LLM while generating typespec!');

    const extractedTypeSpecs = typespec.match(/```typescript([\s\S]*?)```/g);

    if (extractedTypeSpecs?.length) {
      typespec = extractedTypeSpecs[0]
        .replace(/```typescript/g, '')
        .replace(/```/g, '')
        .trim();
    }
  }

  try {
    console.log('Generating table structure...');

    messages.push({
      role: 'assistant',
      content: typespec,
    });

    messages.push({
      role: 'user',
      content: prompts.tableStructure.user,
    });

    tableStructure = await callLLM(messages);

    if (!tableStructure)
      throw new Error('No response from LLM while generating table structure!');

    messages.push({
      role: 'assistant',
      content: tableStructure,
    });
    messages.push({
      role: 'user',
      content: prompts.generateDDL.user,
    });

    console.log('Generating DDL...');

    ddl = await callLLM(messages);

    if (!ddl) throw new Error('No response from LLM while generating DDL!');

    const extractedDDL = ddl.match(/```sql([\s\S]*?)```/g);

    if (extractedDDL?.length) {
      ddl = extractedDDL[0]
        .replace(/```sql/g, '')
        .replace(/```/g, '')
        .trim();
    }

    const structuredDDLMessages: LLMCompatibleMessage[] = [
      {
        role: 'system',
        content: prompts.structureDDL.system(ddl),
      },
      {
        role: 'user',
        content: prompts.structureDDL.user,
      },
    ];

    structuredDDL = await callLLM(structuredDDLMessages);

    if (!structuredDDL)
      throw new Error('No response from LLM while structuring DDL!');

    const extractedStructuredDDL = structuredDDL.match(
      /```typescript([\s\S]*?)```/g,
    );

    if (extractedStructuredDDL?.length) {
      structuredDDL = extractedStructuredDDL[0]
        .replace(/```typescript/g, '')
        .replace(/```/g, '')
        .trim();
    }

    const objectToRowMessages: LLMCompatibleMessage[] = [
      {
        role: 'system',
        content: prompts.objectToRow.system(typespec, ddl),
      },
      {
        role: 'user',
        content: prompts.objectToRow.user,
      },
    ];

    console.log('Generating object to relational function...');

    objectToRowFunc = await callLLM(objectToRowMessages);

    if (!objectToRowFunc)
      throw new Error('No response from LLM while generating objectToRow!');

    const extractedObjectToRowFunc = objectToRowFunc.match(
      /```typescript([\s\S]*?)```/g,
    );

    if (extractedObjectToRowFunc?.length) {
      objectToRowFunc = extractedObjectToRowFunc[0]
        .replace(/```typescript/g, '')
        .replace(/```/g, '')
        .trim();
    }
  } catch (err) {
    console.error('Error running full auto analyze pipeline - ', err);
  } finally {
    if (markdownSaveLocation) {
      const saveFile = path.join(
        markdownSaveLocation,
        `analysis_${new Date().toISOString()}.md`,
      );

      console.log(`Saving to ${saveFile}...`);

      const markdown = MARKDOWN_TEMPLATE(
        inputObj,
        typespec,
        tableStructure,
        ddl,
        structuredDDL,
        objectToRowFunc,
      );
      if (!fs.existsSync(markdownSaveLocation))
        throw new Error(
          `Markdown save location ${markdownSaveLocation} does not exist!`,
        );
      fs.writeFileSync(saveFile, markdown);
    }
  }

  return {
    typespec,
    tableStructure,
    ddl,
    structuredDDL,
    objectToRowFunc,
  };
}

export default autoAnalyzeObject;