/**
 * Format an error for logging, handling both Error instances and structured error objects.
 * 
 * Structured error objects (thrown by handlers) like { code, message, data } would produce
 * "[object Object]" when using String(error). This helper extracts the message properly.
 * 
 * @param error - The error to format (Error instance, structured object, or unknown)
 * @returns A string representation suitable for logging
 */
export function formatError(error: unknown): string {
  // Standard Error instances
  if (error instanceof Error) {
    return error.message;
  }
  
  // Structured error objects with a message property (e.g., { code, message, data })
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  
  // Fallback: try JSON.stringify for objects, String() for primitives
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      // Circular reference or other stringify error
      return String(error);
    }
  }
  
  return String(error);
}
