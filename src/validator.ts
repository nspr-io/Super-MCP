import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ERROR_CODES } from "./types.js";
import { getLogger } from "./logging.js";

const logger = getLogger();

export class ValidationError extends Error {
  code: number;
  errors: any[];
  strippedArgs: string[];
  
  constructor(message: string, errors: any[], strippedArgs: string[] = []) {
    super(message);
    this.name = "ValidationError";
    this.code = ERROR_CODES.ARG_VALIDATION_FAILED;
    this.errors = errors;
    this.strippedArgs = strippedArgs;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: any[];
  strippedArgs: string[];
}

export class Validator {
  private ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({
      strict: false,  // Changed to false to allow unknown formats
      allErrors: true,
      verbose: true,
    });
    
    // Add support for standard formats like date, date-time, email, etc.
    addFormats(this.ajv);
  }

  /** Validates data against schema. Mutates `data` in place to strip unknown
   *  top-level properties when `additionalProperties: false`. Returns validation
   *  status, Ajv errors, and names of stripped properties. */
  validate(schema: any, data: any, context?: { package_id?: string; tool_id?: string }): ValidationResult {
    logger.debug("Validating arguments", {
      package_id: context?.package_id,
      tool_id: context?.tool_id,
      schema_keys: schema ? Object.keys(schema) : [],
      data_keys: typeof data === "object" && data ? Object.keys(data) : [],
    });

    if (!schema) {
      throw new ValidationError("Schema is required", []);
    }

    // Strip unknown top-level properties when schema forbids them.
    // Claude models sometimes hallucinate extra args (e.g. "limit") that cause
    // validation failures and retry loops. We strip and log rather than reject.
    const strippedArgs: string[] = [];
    if (
      schema.additionalProperties === false &&
      schema.properties &&
      typeof data === 'object' &&
      data !== null
    ) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          strippedArgs.push(key);
          delete data[key];
        }
      }
      if (strippedArgs.length > 0) {
        logger.warn("Stripped unknown properties from tool args", {
          package_id: context?.package_id,
          tool_id: context?.tool_id,
          stripped: strippedArgs,
        });
      }
    }

    // Compile schema with better error handling for format issues
    let validate;
    try {
      validate = this.ajv.compile(schema);
    } catch (error) {
      logger.warn("Schema compilation warning", {
        package_id: context?.package_id,
        tool_id: context?.tool_id,
        error: error instanceof Error ? error.message : String(error),
        hint: "This might be due to custom formats in the schema"
      });
      // Re-throw to maintain existing behavior
      throw error;
    }
    
    const valid = validate(data);
    const errors = validate.errors || [];

    if (!valid) {
      logger.warn("Validation failed", {
        package_id: context?.package_id,
        tool_id: context?.tool_id,
        errors: errors.map(err => ({
          instancePath: err.instancePath,
          schemaPath: err.schemaPath,
          keyword: err.keyword,
          message: err.message,
        })),
      });

      return {
        valid: false,
        errors,
        strippedArgs,
      };
    }

    logger.debug("Validation passed", {
      package_id: context?.package_id,
      tool_id: context?.tool_id,
    });

    return {
      valid: true,
      errors,
      strippedArgs,
    };
  }
}

let validator: Validator;

export function getValidator(): Validator {
  if (!validator) {
    validator = new Validator();
  }
  return validator;
}