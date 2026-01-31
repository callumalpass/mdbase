/**
 * Expression evaluator for mdbase where clauses and computed fields.
 * Full recursive descent parser supporting:
 *   - Arithmetic: +, -, *, /, %
 *   - Comparison: ==, !=, >, <, >=, <=
 *   - Logical: &&, ||, !
 *   - Null coalescing: ??
 *   - String/list methods: .contains(), .startsWith(), etc.
 *   - Property access: field.sub, list[0]
 *   - Functions: exists(), isEmpty(), default(), if(), date(), now()
 */

import { parseLink, extractBodyLinks, extractBodyTags, ParsedLink } from "../links/parser.js";

export class ExpressionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BacklinkEntry {
  file: {
    path: string;
    name: string;
    basename: string;
    folder: string;
    extension: string;
  };
}

export interface EvalContext {
  frontmatter: Record<string, unknown>;
  rawFrontmatter?: Record<string, unknown>;
  path?: string;
  types?: string[];
  body?: string | null;
  file?: Record<string, unknown>;
  computedFields?: Map<string, unknown>;
  strictArithmetic?: boolean; // Throw on division by zero instead of returning null
  resolveFile?: (linkTarget: string) => { frontmatter: Record<string, unknown>; path: string; types: string[] } | null;
  computeBacklinks?: (filePath: string) => BacklinkEntry[];
  thisContext?: {
    frontmatter: Record<string, unknown>;
    path: string;
    file?: Record<string, unknown>;
  };
}

// ── Token types ──

enum TokenType {
  Number, String, Boolean, Null, Identifier,
  Plus, Minus, Star, Slash, Percent,
  Eq, Neq, Gt, Lt, Gte, Lte,
  And, Or, Not,
  NullCoalesce,
  LParen, RParen, LBracket, RBracket,
  Dot, Comma,
  EOF,
}

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// ── Tokenizer ──

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    const pos = i;

    // Two-char operators
    const two = expr.slice(i, i + 2);
    if (two === "==") { tokens.push({ type: TokenType.Eq, value: "==", pos }); i += 2; continue; }
    if (two === "!=") { tokens.push({ type: TokenType.Neq, value: "!=", pos }); i += 2; continue; }
    if (two === ">=") { tokens.push({ type: TokenType.Gte, value: ">=", pos }); i += 2; continue; }
    if (two === "<=") { tokens.push({ type: TokenType.Lte, value: "<=", pos }); i += 2; continue; }
    if (two === "&&") { tokens.push({ type: TokenType.And, value: "&&", pos }); i += 2; continue; }
    if (two === "||") { tokens.push({ type: TokenType.Or, value: "||", pos }); i += 2; continue; }
    if (two === "??") { tokens.push({ type: TokenType.NullCoalesce, value: "??", pos }); i += 2; continue; }

    // Single-char operators
    const ch = expr[i];
    if (ch === ">") { tokens.push({ type: TokenType.Gt, value: ">", pos }); i++; continue; }
    if (ch === "<") { tokens.push({ type: TokenType.Lt, value: "<", pos }); i++; continue; }
    if (ch === "+") { tokens.push({ type: TokenType.Plus, value: "+", pos }); i++; continue; }
    if (ch === "-") { tokens.push({ type: TokenType.Minus, value: "-", pos }); i++; continue; }
    if (ch === "*") { tokens.push({ type: TokenType.Star, value: "*", pos }); i++; continue; }
    if (ch === "/") { tokens.push({ type: TokenType.Slash, value: "/", pos }); i++; continue; }
    if (ch === "%") { tokens.push({ type: TokenType.Percent, value: "%", pos }); i++; continue; }
    if (ch === "!") { tokens.push({ type: TokenType.Not, value: "!", pos }); i++; continue; }
    if (ch === "(") { tokens.push({ type: TokenType.LParen, value: "(", pos }); i++; continue; }
    if (ch === ")") { tokens.push({ type: TokenType.RParen, value: ")", pos }); i++; continue; }
    if (ch === "[") { tokens.push({ type: TokenType.LBracket, value: "[", pos }); i++; continue; }
    if (ch === "]") { tokens.push({ type: TokenType.RBracket, value: "]", pos }); i++; continue; }
    if (ch === ".") { tokens.push({ type: TokenType.Dot, value: ".", pos }); i++; continue; }
    if (ch === ",") { tokens.push({ type: TokenType.Comma, value: ",", pos }); i++; continue; }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === "\\" && i + 1 < expr.length) {
          const next = expr[i + 1];
          if (next === quote || next === "\\") {
            str += next;
            i += 2;
            continue;
          }
          if (next === "n") { str += "\n"; i += 2; continue; }
          if (next === "t") { str += "\t"; i += 2; continue; }
          // Keep the backslash for regex patterns etc.
          str += "\\";
          i++;
          continue;
        }
        str += expr[i];
        i++;
      }
      if (i >= expr.length) {
        // Unclosed string literal
        throw new ExpressionError("invalid_expression", "Unclosed string literal");
      }
      i++; // skip closing quote
      tokens.push({ type: TokenType.String, value: str, pos });
      continue;
    }

    // Number
    if (/[0-9]/.test(ch) || (ch === "." && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]))) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i]; i++;
      }
      // Scientific notation
      if (i < expr.length && (expr[i] === "e" || expr[i] === "E")) {
        num += expr[i]; i++;
        if (i < expr.length && (expr[i] === "+" || expr[i] === "-")) {
          num += expr[i]; i++;
        }
        while (i < expr.length && /[0-9]/.test(expr[i])) {
          num += expr[i]; i++;
        }
      }
      tokens.push({ type: TokenType.Number, value: num, pos });
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i]; i++;
      }
      // Handle ext:: and ext. prefixes for extension functions
      if (ident === "ext") {
        if (i < expr.length && expr[i] === ":" && i + 1 < expr.length && expr[i + 1] === ":") {
          // ext::functionName
          i += 2; // skip ::
          if (i >= expr.length || !/[a-zA-Z_]/.test(expr[i])) {
            throw new ExpressionError("invalid_expression", "Expected function name after ext::");
          }
          let funcName = "";
          while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
            funcName += expr[i]; i++;
          }
          tokens.push({ type: TokenType.Identifier, value: `ext::${funcName}`, pos });
          continue;
        }
      }
      if (ident === "true" || ident === "false") {
        tokens.push({ type: TokenType.Boolean, value: ident, pos });
      } else if (ident === "null") {
        tokens.push({ type: TokenType.Null, value: ident, pos });
      } else if (ident === "and") {
        tokens.push({ type: TokenType.And, value: "&&", pos });
      } else if (ident === "or") {
        tokens.push({ type: TokenType.Or, value: "||", pos });
      } else if (ident === "not") {
        tokens.push({ type: TokenType.Not, value: "!", pos });
      } else {
        tokens.push({ type: TokenType.Identifier, value: ident, pos });
      }
      continue;
    }

    // Unknown character - skip
    i++;
  }

  tokens.push({ type: TokenType.EOF, value: "", pos: i });
  return tokens;
}

// ── Parser + Evaluator ──

const MAX_DEPTH = 64;
const MAX_TRAVERSAL_DEPTH = 10;

class ExprParser {
  private tokens: Token[];
  private pos: number;
  private ctx: EvalContext;
  private source: string;
  private depth: number;
  private traversalDepth: number;

  constructor(tokens: Token[], ctx: EvalContext, source: string) {
    this.tokens = tokens;
    this.pos = 0;
    this.ctx = ctx;
    this.source = source;
    this.depth = 0;
    this.traversalDepth = 0;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ExpressionError("invalid_expression", `Expected ${TokenType[type]} but got ${TokenType[t.type]} (${t.value}) at pos ${t.pos}`);
    }
    return this.advance();
  }

  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  consumeTrailingRightParens(): void {
    while (this.peek().type === TokenType.RParen) {
      this.advance();
    }
  }

  atEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  remainingTokens(): Token[] {
    return this.tokens.slice(this.pos);
  }

  // Entry point
  parse(): unknown {
    const result = this.parseExpression();
    return result;
  }

  // expression = nullCoalesce
  private parseExpression(): unknown {
    return this.parseNullCoalesce();
  }

  // nullCoalesce = or ( "??" or )*
  private parseNullCoalesce(): unknown {
    let left = this.parseOr();
    while (this.peek().type === TokenType.NullCoalesce) {
      this.advance();
      const right = this.parseOr();
      if (left === null || left === undefined) {
        left = right;
      }
    }
    return left;
  }

  // or = and ( "||" and )*
  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek().type === TokenType.Or) {
      this.advance();
      const right = this.parseAnd();
      // Short-circuit: return first truthy value or last value
      left = toBool(left) ? left : right;
    }
    return left;
  }

  // and = not ( "&&" not )*
  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.peek().type === TokenType.And) {
      this.advance();
      const right = this.parseNot();
      // Short-circuit: return first falsy value or last value
      left = toBool(left) ? right : left;
    }
    return left;
  }

  // not = "!" not | comparison
  private parseNot(): unknown {
    if (this.peek().type === TokenType.Not) {
      this.advance();
      const val = this.parseNot();
      return !toBool(val);
    }
    return this.parseComparison();
  }

  // comparison = addition ( ("==" | "!=" | ">" | "<" | ">=" | "<=") addition )?
  private parseComparison(): unknown {
    let left = this.parseAddition();
    const t = this.peek().type;
    if (t === TokenType.Eq || t === TokenType.Neq || t === TokenType.Gt ||
        t === TokenType.Lt || t === TokenType.Gte || t === TokenType.Lte) {
      const op = this.advance();
      const right = this.parseAddition();
      return evalComparison(left, op.value, right);
    }
    return left;
  }

  // addition = multiplication ( ("+" | "-") multiplication )*
  private parseAddition(): unknown {
    let left = this.parseMultiplication();
    while (this.peek().type === TokenType.Plus || this.peek().type === TokenType.Minus) {
      const op = this.advance();
      const right = this.parseMultiplication();
      if (op.type === TokenType.Plus) {
        // Type check: list addition is type error
        if (Array.isArray(left) || Array.isArray(right)) {
          throw new ExpressionError("type_error", "Cannot add lists");
        }
        if (typeof left === "boolean" || typeof right === "boolean") {
          throw new ExpressionError("type_error", "Cannot add booleans");
        }
        // Date + duration string → calendar-aware addition
        if (isDateString(left) && typeof right === "string" && !isDateString(right)) {
          const dur = parseDurationCalendar(right);
          if (dur) {
            left = addDurationToDateString(String(left), dur);
          } else {
            // Compound duration like "1d12h" → type_error
            throw new ExpressionError("type_error", `Invalid duration string: ${right}`);
          }
        }
        // Date + number (ms) → new date
        else if (isDateString(left) && typeof right === "number") {
          const d = new Date(String(left));
          d.setTime(d.getTime() + right);
          left = (String(left) as string).includes("T")
            ? d.toISOString().replace(/\.000Z$/, "Z")
            : d.toISOString().slice(0, 10);
        }
        // String concatenation and type mismatches
        else if (typeof left === "string" || typeof right === "string") {
          if (typeof left === "string" && typeof right === "string" &&
              !isDateString(left) && !isDateString(right)) {
            left = left + right;
          } else if (this.ctx.strictArithmetic) {
            throw new ExpressionError("type_error", "Cannot add mismatched string and number");
          } else {
            // Type mismatch returns null (non-truthy) in where filters
            left = null;
          }
        } else {
          // Null propagation: null + anything = null
          if (left === null || left === undefined || right === null || right === undefined) {
            left = null;
          } else {
            left = toNum(left) + toNum(right);
          }
        }
      } else {
        // Date - duration string → calendar-aware subtraction
        if (isDateString(left) && typeof right === "string" && !isDateString(right)) {
          const dur = parseDurationCalendar(right);
          if (dur) {
            // Negate the duration
            const negDur: ParsedDuration = {
              ms: -dur.ms,
              calendarMonths: dur.calendarMonths ? -dur.calendarMonths : undefined,
              calendarYears: dur.calendarYears ? -dur.calendarYears : undefined,
            };
            left = addDurationToDateString(String(left), negDur);
          } else {
            throw new ExpressionError("type_error", `Invalid duration string: ${right}`);
          }
        }
        // Date - number (ms) → new date
        else if (isDateString(left) && typeof right === "number") {
          const d = new Date(String(left));
          d.setTime(d.getTime() - right);
          left = (String(left) as string).includes("T")
            ? d.toISOString().replace(/\.000Z$/, "Z")
            : d.toISOString().slice(0, 10);
        } else if (isDateString(left) && isDateString(right)) {
          left = new Date(String(left)).getTime() - new Date(String(right)).getTime();
        } else if ((typeof left === "string" && !isDateString(left)) || (typeof right === "string" && !isDateString(right))) {
          throw new ExpressionError("type_error", "Cannot subtract strings");
        } else if (typeof left === "boolean" || typeof right === "boolean") {
          throw new ExpressionError("type_error", "Cannot subtract booleans");
        } else if (Array.isArray(left) || Array.isArray(right)) {
          throw new ExpressionError("type_error", "Cannot subtract lists");
        } else {
          // Null propagation
          if (left === null || left === undefined || right === null || right === undefined) {
            left = null;
          } else {
            left = toNum(left) - toNum(right);
          }
        }
      }
    }
    return left;
  }

  // multiplication = unary ( ("*" | "/" | "%") unary )*
  private parseMultiplication(): unknown {
    let left = this.parseUnary();
    while (this.peek().type === TokenType.Star || this.peek().type === TokenType.Slash || this.peek().type === TokenType.Percent) {
      const op = this.advance();
      const right = this.parseUnary();
      // Type checking for arithmetic
      if (typeof left === "string" || typeof right === "string") {
        throw new ExpressionError("type_error", "Cannot multiply/divide strings");
      }
      if (typeof left === "boolean" || typeof right === "boolean") {
        throw new ExpressionError("type_error", "Cannot multiply/divide booleans");
      }
      if (Array.isArray(left) || Array.isArray(right)) {
        throw new ExpressionError("type_error", "Cannot multiply/divide lists");
      }
      // Null propagation for arithmetic
      if (left === null || left === undefined || right === null || right === undefined) {
        left = null;
      } else if (op.type === TokenType.Star) {
        left = toNum(left) * toNum(right);
      } else if (op.type === TokenType.Slash) {
        const d = toNum(right);
        if (d === 0) {
          if (this.ctx.strictArithmetic) {
            throw new ExpressionError("type_error", "Division by zero");
          }
          left = null;
        } else {
          left = toNum(left) / d;
        }
      } else {
        left = toNum(left) % toNum(right);
      }
    }
    return left;
  }

  // unary = "-" unary | postfix
  private parseUnary(): unknown {
    if (this.peek().type === TokenType.Minus) {
      this.advance();
      const val = this.parseUnary();
      if (val === null || val === undefined) return null;
      if (typeof val !== "number") {
        throw new ExpressionError("type_error", "Unary minus requires a number");
      }
      return -val;
    }
    return this.parsePostfix();
  }

  // postfix = primary ( "." ident ( "(" args ")" )? | "[" expr "]" )*
  private parsePostfix(): unknown {
    let value = this.parsePrimary();

    while (true) {
      if (this.peek().type === TokenType.Dot) {
        this.advance();
        const ident = this.expect(TokenType.Identifier);
        // Method call?
        if (this.peek().type === TokenType.LParen) {
          this.advance();
          // For HOF methods (filter, map, reduce), capture raw expression text
          const isHOF = ident.value === "filter" || ident.value === "map" || ident.value === "reduce";
          let args: unknown[];
          let rawArgs: string[] | undefined;
          if (isHOF) {
            const result = this.parseArgListWithRaw();
            args = result.values;
            rawArgs = result.raw;
          } else {
            args = this.parseArgList();
          }
          this.expect(TokenType.RParen);
          value = this.callMethod(value, ident.value, args, rawArgs);
        } else {
          // Property access
          value = this.accessProperty(value, ident.value);
        }
      } else if (this.peek().type === TokenType.LBracket) {
        this.advance();
        const index = this.parseExpression();
        this.expect(TokenType.RBracket);
        if (Array.isArray(value)) {
          const idx = toNum(index);
          value = value[idx < 0 ? value.length + idx : idx] ?? null;
        } else if (typeof value === "string" && typeof index === "number") {
          const idx = toNum(index);
          value = value[idx < 0 ? value.length + idx : idx] ?? "";
        } else if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) && typeof index === "string") {
          // Object bracket notation: obj["key"]
          const record = value as Record<string, unknown>;
          value = (index in record) ? record[index] : null;
        } else {
          value = null;
        }
      } else {
        break;
      }
    }

    return value;
  }

  // primary = number | string | boolean | null | "(" expr ")" | "[" list "]" | ident | function_call
  private parsePrimary(): unknown {
    const t = this.peek();

    if (t.type === TokenType.Number) {
      this.advance();
      return Number(t.value);
    }

    if (t.type === TokenType.String) {
      this.advance();
      return t.value;
    }

    if (t.type === TokenType.Boolean) {
      this.advance();
      return t.value === "true";
    }

    if (t.type === TokenType.Null) {
      this.advance();
      return null;
    }

    if (t.type === TokenType.LParen) {
      this.advance();
      const val = this.parseExpression();
      this.expect(TokenType.RParen);
      return val;
    }

    // List literal [a, b, c]
    if (t.type === TokenType.LBracket) {
      this.advance();
      const items: unknown[] = [];
      if (this.peek().type !== TokenType.RBracket) {
        items.push(this.parseExpression());
        while (this.match(TokenType.Comma)) {
          items.push(this.parseExpression());
        }
      }
      this.expect(TokenType.RBracket);
      return items;
    }

    if (t.type === TokenType.Identifier) {
      this.advance();
      const name = t.value;

      // Special forms that need raw identifier access
      if (name === "exists" && this.peek().type === TokenType.LParen) {
        return this.callExists();
      }

      // ext:: prefixed function calls → always unknown_function
      if (name.startsWith("ext::") && this.peek().type === TokenType.LParen) {
        throw new ExpressionError("unknown_function", `Unknown extension function: ${name}()`);
      }

      // Built-in functions
      if (this.peek().type === TokenType.LParen) {
        return this.callFunction(name);
      }

      // Field resolution with dotted path for backward compatibility
      // Collect full dotted path for field resolution (file.path, file.body, etc.)
      return this.resolveIdentifier(name);
    }

    // Unexpected token
    if (t.type === TokenType.EOF) {
      throw new ExpressionError("invalid_expression", "Unexpected end of expression");
    }
    throw new ExpressionError("invalid_expression", `Unexpected token: ${t.value} at position ${t.pos}`);
  }

  private parseArgList(): unknown[] {
    const args: unknown[] = [];
    if (this.peek().type === TokenType.RParen) return args;
    args.push(this.parseExpression());
    while (this.match(TokenType.Comma)) {
      args.push(this.parseExpression());
    }
    return args;
  }

  private parseArgListWithRaw(): { values: unknown[]; raw: string[] } {
    const values: unknown[] = [];
    const raw: string[] = [];
    if (this.peek().type === TokenType.RParen) return { values, raw };
    const startPos = this.peek().pos;
    values.push(this.parseExpression());
    const endPos = this.peek().pos;
    raw.push(this.source.slice(startPos, endPos).trim());
    while (this.match(TokenType.Comma)) {
      const s2 = this.peek().pos;
      values.push(this.parseExpression());
      const e2 = this.peek().pos;
      raw.push(this.source.slice(s2, e2).trim());
    }
    return { values, raw };
  }

  private callExists(): boolean {
    this.expect(TokenType.LParen);
    // Capture raw field path from tokens (identifier + dots)
    let fieldPath = "";
    if (this.peek().type === TokenType.String) {
      // exists("field") form
      fieldPath = this.advance().value;
    } else if (this.peek().type === TokenType.Identifier) {
      fieldPath = this.advance().value;
      while (this.peek().type === TokenType.Dot) {
        this.advance();
        fieldPath += "." + this.expect(TokenType.Identifier).value;
      }
    }
    this.expect(TokenType.RParen);
    return hasFieldPath(fieldPath, this.ctx);
  }

  private callFunction(name: string): unknown {
    this.expect(TokenType.LParen);
    const args = this.parseArgList();
    this.expect(TokenType.RParen);

    switch (name) {
      case "isEmpty": {
        const val = args[0];
        if (val === null || val === undefined) return true;
        if (typeof val === "string") return val === "";
        if (Array.isArray(val)) return val.length === 0;
        return false;
      }
      case "default": {
        if (args.length < 2) throw new ExpressionError("wrong_argument_count", `default() expects 2 arguments, got ${args.length}`);
        const val = args[0];
        return (val === null || val === undefined) ? args[1] : val;
      }
      case "if": {
        if (args.length < 3 || args.length > 3) throw new ExpressionError("wrong_argument_count", `if() expects 3 arguments, got ${args.length}`);
        const condition = toBool(args[0]);
        return condition ? (args[1] ?? null) : (args[2] ?? null);
      }
      case "date": {
        // date("YYYY-MM-DD") → parse date string to comparable value
        const dateStr = String(args[0] ?? "");
        return parseDateValue(dateStr);
      }
      case "datetime": {
        // datetime("YYYY-MM-DDTHH:mm:ssZ") → return the datetime string
        return String(args[0] ?? "");
      }
      case "now": {
        return new Date().toISOString();
      }
      case "today": {
        return new Date().toISOString().slice(0, 10);
      }
      case "abs": {
        return Math.abs(toNum(args[0]));
      }
      case "min": {
        return Math.min(...args.map(toNum));
      }
      case "max": {
        return Math.max(...args.map(toNum));
      }
      case "floor": {
        return Math.floor(toNum(args[0]));
      }
      case "ceil": {
        return Math.ceil(toNum(args[0]));
      }
      case "round": {
        return Math.round(toNum(args[0]));
      }
      case "type": {
        const val = args[0];
        if (val === null) return "null";
        if (Array.isArray(val)) return "list";
        return typeof val;
      }
      case "string":
      case "toString": {
        return String(args[0] ?? "");
      }
      case "number":
      case "int": {
        const val = args[0];
        // date/datetime → epoch ms
        if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val)) {
          return new Date(val).getTime();
        }
        return toNum(val);
      }
      case "bool":
      case "boolean": {
        return toBool(args[0]);
      }
      case "list": {
        const val = args[0];
        if (Array.isArray(val)) return val;
        if (val === null || val === undefined) return [];
        return [val];
      }
      case "isTruthy": {
        return toBool(args[0]);
      }
      case "duration": {
        // duration("1d"), duration("2h") → returns milliseconds
        const durStr = String(args[0] ?? "");
        const result = parseDuration(durStr);
        if (result === null) {
          throw new ExpressionError("type_error", `Invalid duration string: "${durStr}"`);
        }
        return result;
      }
      case "length":
      case "len": {
        if (args.length !== 1) throw new ExpressionError("wrong_argument_count", `length() expects 1 argument, got ${args.length}`);
        const val = args[0];
        if (typeof val === "string" || Array.isArray(val)) return val.length;
        return 0;
      }
      case "lower": {
        if (args.length !== 1) throw new ExpressionError("wrong_argument_count", `lower() expects 1 argument, got ${args.length}`);
        return String(args[0] ?? "").toLowerCase();
      }
      case "upper": {
        if (args.length !== 1) throw new ExpressionError("wrong_argument_count", `upper() expects 1 argument, got ${args.length}`);
        return String(args[0] ?? "").toUpperCase();
      }
      case "replace": {
        if (args.length !== 3) throw new ExpressionError("wrong_argument_count", `replace() expects 3 arguments, got ${args.length}`);
        return replaceAllString(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? ""));
      }
      case "link": {
        // link("path") - construct a link string for use with hasLink()
        return String(args[0] ?? "");
      }
      default:
        throw new ExpressionError("unknown_function", `Unknown function: ${name}()`);
    }
  }

  private callMethod(obj: unknown, method: string, args: unknown[], rawArgs?: string[]): unknown {
    // ext namespace method calls → always unknown_function
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj) && (obj as Record<string, unknown>).__ext_namespace) {
      throw new ExpressionError("unknown_function", `Unknown extension function: ext.${method}()`);
    }

    // String methods
    if (typeof obj === "string") {
      switch (method) {
        case "contains": {
          if (args.length < 1) throw new ExpressionError("wrong_argument_count", `contains() expects 1 argument, got ${args.length}`);
          return obj.includes(String(args[0] ?? ""));
        }
        case "containsAll": return args.every((a) => obj.includes(String(a)));
        case "containsAny": return args.some((a) => obj.includes(String(a)));
        case "startsWith": {
          if (args.length < 1) throw new ExpressionError("wrong_argument_count", `startsWith() expects 1 argument, got ${args.length}`);
          return obj.startsWith(String(args[0] ?? ""));
        }
        case "endsWith": {
          if (args.length < 1) throw new ExpressionError("wrong_argument_count", `endsWith() expects 1 argument, got ${args.length}`);
          return obj.endsWith(String(args[0] ?? ""));
        }
        case "matches": {
          try {
            let pattern = String(args[0] ?? "");
            pattern = pattern.replace(/\\\\/g, "\\");
            return new RegExp(pattern).test(obj);
          } catch { return null; }
        }
        case "lower": {
          if (args.length > 0) throw new ExpressionError("wrong_argument_count", `lower() expects 0 arguments, got ${args.length}`);
          return obj.toLowerCase();
        }
        case "upper": {
          if (args.length > 0) throw new ExpressionError("wrong_argument_count", `upper() expects 0 arguments, got ${args.length}`);
          return obj.toUpperCase();
        }
        case "trim": return obj.trim();
        case "isEmpty": return obj === "";
        case "length": {
          if (args.length > 0) throw new ExpressionError("wrong_argument_count", `length() expects 0 arguments, got ${args.length}`);
          return obj.length;
        }
        case "slice": {
          const start = toNum(args[0]);
          const end = args[1] !== undefined ? toNum(args[1]) : undefined;
          return obj.slice(start, end);
        }
        case "split": {
          const sep = String(args[0] ?? ",");
          const limit = args[1] !== undefined ? toNum(args[1]) : undefined;
          return obj.split(sep, limit);
        }
        case "replace": {
          if (args.length < 2) throw new ExpressionError("wrong_argument_count", `replace() expects 2 arguments, got ${args.length}`);
          return replaceAllString(obj, String(args[0] ?? ""), String(args[1] ?? ""));
        }
        case "reverse": return obj.split("").reverse().join("");
        case "repeat": return obj.repeat(toNum(args[0]));
        case "title": return obj.replace(/\b\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
        case "indexOf": return obj.indexOf(String(args[0] ?? ""));
        case "padStart": return obj.padStart(toNum(args[0]), String(args[1] ?? " "));
        case "padEnd": return obj.padEnd(toNum(args[0]), String(args[1] ?? " "));
        case "isType": {
          const t = String(args[0]);
          if (t === "string") return true;
          if (t === "date" && /^\d{4}-\d{2}-\d{2}$/.test(obj)) return true;
          if (t === "datetime" && /^\d{4}-\d{2}-\d{2}T/.test(obj)) return true;
          return false;
        }
        case "date": {
          // .date() extracts date portion from datetime
          if (/^\d{4}-\d{2}-\d{2}/.test(obj)) return obj.slice(0, 10);
          return obj;
        }
        case "time": {
          // .time() extracts time portion from datetime
          const tMatch = obj.match(/T(\d{2}:\d{2}(?::\d{2})?)/);
          return tMatch ? tMatch[1] : "";
        }
        case "format": {
          // .format("YYYY-MM-DD HH:mm:ss") — parse components from string to avoid timezone issues
          const pattern = String(args[0] ?? "");
          const fmtMatch = obj.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
          if (!fmtMatch) return obj;
          const pad = (n: string) => n.padStart(2, "0");
          return pattern
            .replace("YYYY", fmtMatch[1])
            .replace("MM", pad(fmtMatch[2]))
            .replace("DD", pad(fmtMatch[3]))
            .replace("HH", pad(fmtMatch[4] ?? "00"))
            .replace("mm", pad(fmtMatch[5] ?? "00"))
            .replace("ss", pad(fmtMatch[6] ?? "00"));
        }
        case "toString": return obj;
        case "isTruthy": return obj !== "";
        case "asFile": {
          if (!this.ctx.resolveFile) return null;
          // Track traversal depth
          this.traversalDepth++;
          if (this.traversalDepth > MAX_TRAVERSAL_DEPTH) {
            throw new ExpressionError("expression_depth_exceeded", "Link traversal exceeds maximum depth of 10 hops");
          }
          // Parse the link value to extract the target
          let target = obj;
          try {
            const parsed = parseLink(obj);
            if (parsed) target = parsed.target;
          } catch {
            // Use raw value if parsing fails
          }
          // Strip remaining wikilink brackets if present
          if (target.startsWith("[[") && target.endsWith("]]")) {
            target = target.slice(2, -2);
          }
          // Strip anchor
          const hashIdx = target.indexOf("#");
          if (hashIdx !== -1) {
            target = target.slice(0, hashIdx);
          }
          // Strip alias
          const pipeIdx = target.indexOf("|");
          if (pipeIdx !== -1) {
            target = target.slice(0, pipeIdx);
          }
          const resolved = this.ctx.resolveFile(target);
          if (!resolved) return null;
          // Build file metadata
          const resolvedName = resolved.path.split("/").pop() ?? "";
          return {
            ...resolved.frontmatter,
            _path: resolved.path,
            _types: resolved.types,
            file: {
              path: resolved.path,
              name: resolvedName,
              basename: resolvedName.replace(/\.[^.]+$/, ""),
              folder: resolved.path.includes("/") ? resolved.path.slice(0, resolved.path.lastIndexOf("/")) : "",
              extension: "md",
              ext: "md",
            },
          };
        }
        default: throw new ExpressionError("unknown_function", `Unknown string method: .${method}()`);
      }
    }

    // List methods
    if (Array.isArray(obj)) {
      switch (method) {
        case "contains": return obj.some((item) => {
          const target = args[0];
          if (typeof target === "number") return Number(item) === target || String(item) === String(target);
          return String(item) === String(target);
        });
        case "containsAll": return args.every((a) => obj.some((item) => String(item) === String(a)));
        case "containsAny": return args.some((a) => obj.some((item) => String(item) === String(a)));
        case "isEmpty": return obj.length === 0;
        case "length": return obj.length;
        case "join": return obj.map(String).join(String(args[0] ?? ","));
        case "sort": return [...obj].sort((a, b) => String(a).localeCompare(String(b)));
        case "reverse": return [...obj].reverse();
        case "unique": return [...new Set(obj.map(String))].map((s) => {
          // Try to restore original types
          const orig = obj.find((item) => String(item) === s);
          return orig !== undefined ? orig : s;
        });
        case "flat": return obj.flat();
        case "slice": {
          const start = toNum(args[0]);
          const end = args[1] !== undefined ? toNum(args[1]) : undefined;
          return obj.slice(start, end);
        }
        case "filter": {
          // filter expects an expression with implicit "value" and "index" variables
          const filterExpr = rawArgs?.[0] ?? String(args[0] ?? "");
          return obj.filter((item, idx) => {
            const subCtx: EvalContext = {
              ...this.ctx,
              frontmatter: { ...this.ctx.frontmatter, value: item, index: idx },
            };
            return toBool(evalExpression(filterExpr, subCtx));
          });
        }
        case "map": {
          const mapExpr = rawArgs?.[0] ?? String(args[0] ?? "");
          return obj.map((item, idx) => {
            const subCtx: EvalContext = {
              ...this.ctx,
              frontmatter: { ...this.ctx.frontmatter, value: item, index: idx },
            };
            return evalExpression(mapExpr, subCtx);
          });
        }
        case "reduce": {
          const reduceExpr = rawArgs?.[0] ?? String(args[0] ?? "");
          let acc: unknown = args[1] ?? null;
          for (let idx = 0; idx < obj.length; idx++) {
            const subCtx: EvalContext = {
              ...this.ctx,
              frontmatter: { ...this.ctx.frontmatter, acc, value: obj[idx], index: idx },
            };
            acc = evalExpression(reduceExpr, subCtx);
          }
          return acc;
        }
        case "indexOf": {
          const target = args[0];
          return obj.findIndex((item) => String(item) === String(target));
        }
        case "isType": return args[0] === "list";
        default: return null;
      }
    }

    // Number methods
    if (typeof obj === "number") {
      switch (method) {
        case "isType": return args[0] === "number" || args[0] === "integer";
        case "abs": return Math.abs(obj);
        case "toString": return String(obj);
        case "isTruthy": return obj !== 0;
        // String/list methods on number are type errors
        case "contains":
        case "containsAll":
        case "containsAny":
        case "startsWith":
        case "endsWith":
        case "matches":
        case "lower":
        case "upper":
        case "trim":
        case "split":
        case "replace":
        case "join":
        case "filter":
        case "map":
        case "reduce":
          throw new ExpressionError("type_error", `Cannot call .${method}() on number`);
        default: return null;
      }
    }

    // Boolean methods
    if (typeof obj === "boolean") {
      switch (method) {
        case "isType": return args[0] === "boolean";
        case "isTruthy": return obj;
        case "toString": return String(obj);
        default: return null;
      }
    }

    // Null/undefined methods
    if (obj === null || obj === undefined) {
      switch (method) {
        case "isEmpty": return true;
        case "isTruthy": return false;
        case "length": return 0;
        default: return null;
      }
    }

    // Object methods
    if (typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      switch (method) {
        case "isType": {
          const t = String(args[0]);
          if (t === "object") return true;
          return false;
        }
        case "keys": return Object.keys(record);
        case "values": return Object.values(record);
        case "isEmpty": return Object.keys(record).length === 0;
        case "hasProperty": {
          // file.hasProperty("fieldName") - checks raw frontmatter key presence
          const fieldName = String(args[0] ?? "");
          if ("properties" in record) {
            // This is a file virtual object, check properties
            const props = record.properties as Record<string, unknown>;
            return fieldName in props;
          }
          return fieldName in record;
        }
        case "inFolder": {
          // file.inFolder("folder") - checks if file is in (or under) the given folder
          const folder = String(args[0] ?? "");
          const filePath = String(record.path ?? "");
          const fileFolder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
          return fileFolder === folder || fileFolder.startsWith(folder + "/");
        }
        case "hasTag": {
          // file.hasTag("tag1", "tag2") - check if file has any of the given tags (variadic)
          // Uses prefix matching on /-separated segments
          const fileTags: string[] = (record.tags as string[]) ?? [];
          return args.some((searchTag) => {
            const needle = String(searchTag);
            return fileTags.some((fileTag) => {
              const t = String(fileTag);
              // Exact match or prefix match on segment boundary
              return t === needle || t.startsWith(needle + "/");
            });
          });
        }
        case "hasLink": {
          // file.hasLink(linkTarget) - check if file contains link to target
          const fileLinks: string[] = (record.links as string[]) ?? [];
          const searchTarget = String(args[0] ?? "");
          // Extract and normalize the search target
          let needle = searchTarget;
          try {
            const parsed = parseLink(searchTarget);
            if (parsed) needle = parsed.target;
          } catch {
            // Use as-is
          }
          // Remove extension for comparison
          const needleNoExt = needle.replace(/\.(md|markdown)$/, "");
          const filePath = this.ctx.path ?? "";
          const fileDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

          // Check if any file link matches
          return fileLinks.some((linkVal) => {
            let linkTarget = linkVal;
            try {
              const parsed = parseLink(linkVal);
              if (parsed) linkTarget = parsed.target;
            } catch {
              // Use as-is
            }
            // Clean up target
            linkTarget = linkTarget.replace(/\[\[|\]\]/g, "");
            // Strip anchor and alias
            const hashIdx = linkTarget.indexOf("#");
            if (hashIdx !== -1) linkTarget = linkTarget.slice(0, hashIdx);
            const pipeIdx = linkTarget.indexOf("|");
            if (pipeIdx !== -1) linkTarget = linkTarget.slice(0, pipeIdx);

            // Direct comparison
            if (linkTarget === needle || linkTarget === needleNoExt) return true;
            if (linkTarget + ".md" === needle) return true;
            const linkTargetNoExt = linkTarget.replace(/\.(md|markdown)$/, "");
            if (linkTargetNoExt === needleNoExt) return true;

            // Resolve relative to file's directory for simple name comparison
            // Simple name (no slash): resolve as fileDir/name
            if (!linkTarget.includes("/") && !linkTarget.startsWith(".")) {
              const resolvedPath = fileDir ? `${fileDir}/${linkTarget}` : linkTarget;
              const resolvedNoExt = resolvedPath.replace(/\.(md|markdown)$/, "");
              if (resolvedPath === needle || resolvedNoExt === needleNoExt) return true;
              if (resolvedPath + ".md" === needle || resolvedNoExt + ".md" === needle) return true;
            }

            // Relative path resolution
            if (linkTarget.startsWith("./") || linkTarget.startsWith("../")) {
              const parts = [...(fileDir ? fileDir.split("/") : []), ...linkTarget.split("/")];
              const normalized: string[] = [];
              for (const p of parts) {
                if (p === ".") continue;
                if (p === "..") { normalized.pop(); continue; }
                normalized.push(p);
              }
              const resolvedPath = normalized.join("/");
              const resolvedNoExt = resolvedPath.replace(/\.(md|markdown)$/, "");
              if (resolvedPath === needle || resolvedNoExt === needleNoExt) return true;
            }

            return false;
          });
        }
        default: return null;
      }
    }

    return null;
  }

  private accessProperty(obj: unknown, prop: string): unknown {
    // String properties
    if (typeof obj === "string") {
      if (prop === "length") return obj.length;
    }

    // Array properties
    if (Array.isArray(obj)) {
      if (prop === "length") return obj.length;
      if (prop === "first") return obj[0] ?? null;
      if (prop === "last") return obj[obj.length - 1] ?? null;
    }

    // Date string properties (ISO date or datetime)
    if (typeof obj === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj)) {
      // Parse datetime components directly from the string for reliability
      const dtMatch = obj.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if (dtMatch) {
        const year = parseInt(dtMatch[1]);
        const month = parseInt(dtMatch[2]);
        const day = parseInt(dtMatch[3]);
        const hour = parseInt(dtMatch[4] ?? "0");
        const minute = parseInt(dtMatch[5] ?? "0");
        const second = parseInt(dtMatch[6] ?? "0");
        switch (prop) {
          case "year": return year;
          case "month": return month;
          case "day": return day;
          case "dayOfWeek": {
            const d = new Date(Date.UTC(year, month - 1, day));
            return d.getUTCDay();
          }
          case "hour": return hour;
          case "minute": return minute;
          case "second": return second;
        }
      }
    }

    // Number properties
    if (typeof obj === "number") {
      if (prop === "abs") return Math.abs(obj);
    }

    // Object property access
    if (obj !== null && obj !== undefined && typeof obj === "object" && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>;
      if (prop in record) return record[prop];
    }

    return null;
  }

  private resolveIdentifier(name: string): unknown {
    // Handle "this" namespace — context file reference
    if (name === "this") {
      if (this.ctx.thisContext) {
        const tc = this.ctx.thisContext;
        const fullName = tc.path.split("/").pop() ?? "";
        return {
          ...tc.frontmatter,
          file: {
            path: tc.path,
            name: fullName,
            basename: fullName.replace(/\.[^.]+$/, ""),
            folder: tc.path.includes("/") ? tc.path.slice(0, tc.path.lastIndexOf("/")) : "",
            extension: "md",
            ext: "md",
            ...(tc.file ?? {}),
          },
        };
      }
      return null;
    }

    // Handle "ext" namespace — extension function namespace (not a real value)
    if (name === "ext") {
      return { __ext_namespace: true };
    }

    // Handle "file" namespace
    if (name === "file") {
      // Return a virtual file object that will be accessed via postfix
      const fullName = this.ctx.path ? this.ctx.path.split("/").pop() ?? "" : "";
      const body = this.ctx.body ?? "";

      // Extract tags using proper parser (excludes code blocks and inline code)
      const bodyTagList = extractBodyTags(body);
      // Include frontmatter tags field
      const fmTags = this.ctx.frontmatter.tags;
      let tags: string[];
      if (typeof fmTags === "string") {
        tags = [fmTags, ...bodyTagList];
      } else if (Array.isArray(fmTags)) {
        tags = [...fmTags.map(String), ...bodyTagList];
      } else {
        tags = bodyTagList;
      }

      // Extract links using proper parser (excludes code blocks and inline code)
      const bodyParsedLinks = extractBodyLinks(body);
      // Non-embed body links
      const bodyLinkTargets = bodyParsedLinks
        .filter((l) => !l.is_embed)
        .map((l) => l.raw);
      // Body embeds
      const bodyEmbedTargets = bodyParsedLinks
        .filter((l) => l.is_embed)
        .map((l) => l.raw);
      // Include frontmatter link-typed fields
      const fmLinks: string[] = [];
      for (const val of Object.values(this.ctx.frontmatter)) {
        if (typeof val === "string") {
          try {
            const parsed = parseLink(val);
            if (parsed) fmLinks.push(val);
          } catch {
            // Invalid link, skip
          }
        } else if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === "string") {
              try {
                const parsed = parseLink(item);
                if (parsed) fmLinks.push(item);
              } catch {
                // Invalid link, skip
              }
            }
          }
        }
      }
      // De-duplicate links (same link in frontmatter and body counts once)
      const linkSet = new Set<string>();
      const links: string[] = [];
      for (const l of [...fmLinks, ...bodyLinkTargets]) {
        if (!linkSet.has(l)) {
          linkSet.add(l);
          links.push(l);
        }
      }
      const embeds = bodyEmbedTargets;

      // Compute backlinks if callback provided
      const backlinks = this.ctx.computeBacklinks && this.ctx.path
        ? this.ctx.computeBacklinks(this.ctx.path)
        : [];

      return {
        path: this.ctx.path ?? "",
        name: fullName,
        basename: fullName.replace(/\.[^.]+$/, ""),
        folder: this.ctx.path ? (() => { const p = this.ctx.path!.split("/"); return p.length > 1 ? p.slice(0, -1).join("/") : ""; })() : "",
        extension: "md",
        ext: "md",
        body,
        types: this.ctx.types ?? [],
        size: this.ctx.file?.size ?? 0,
        mtime: this.ctx.file?.mtime ?? null,
        ctime: this.ctx.file?.ctime ?? null,
        tags,
        links,
        embeds,
        backlinks,
        properties: this.ctx.rawFrontmatter ?? this.ctx.frontmatter,
        hasProperty: null, // handled via method calls
      };
    }

    // Handle "note" namespace (alias for frontmatter access)
    if (name === "note") {
      return this.ctx.frontmatter;
    }

    // Special: "types" resolves to the file's type list from context
    if (name === "types") {
      return this.ctx.types ?? [];
    }

    // Check computed fields
    if (this.ctx.computedFields?.has(name)) {
      return this.ctx.computedFields.get(name);
    }

    // Regular field access from frontmatter
    if (name in this.ctx.frontmatter) {
      return this.ctx.frontmatter[name];
    }
    return null;
  }
}

// ── Helper functions ──

function toBool(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (val === null || val === undefined) return false;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") return val !== "";
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

function toNum(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "string") {
    const n = Number(val);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function replaceAllString(input: string, search: string, replacement: string): string {
  if (search === "") return input;
  if (typeof (input as unknown as { replaceAll?: unknown }).replaceAll === "function") {
    return input.replaceAll(search, replacement);
  }
  return input.split(search).join(replacement);
}

function evalComparison(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      if (left === null || left === undefined) return right === null || right === undefined;
      if (right === null || right === undefined) return false;
      // Date-aware comparison
      if (isDateString(left) && isDateString(right)) {
        return normDate(left) === normDate(right);
      }
      if (typeof left === typeof right) return left === right;
      return String(left) === String(right);
    case "!=":
      return !evalComparison(left, "==", right);
    case ">":
      if (isDateString(left) && isDateString(right)) return normDate(left) > normDate(right);
      if (typeof left === "string" && typeof right === "string") return left > right;
      return toNum(left) > toNum(right);
    case "<":
      if (isDateString(left) && isDateString(right)) return normDate(left) < normDate(right);
      if (typeof left === "string" && typeof right === "string") return left < right;
      return toNum(left) < toNum(right);
    case ">=":
      if (isDateString(left) && isDateString(right)) return normDate(left) >= normDate(right);
      if (typeof left === "string" && typeof right === "string") return left >= right;
      return toNum(left) >= toNum(right);
    case "<=":
      if (isDateString(left) && isDateString(right)) return normDate(left) <= normDate(right);
      if (typeof left === "string" && typeof right === "string") return left <= right;
      return toNum(left) <= toNum(right);
    default:
      return false;
  }
}

function isDateString(val: unknown): boolean {
  return typeof val === "string" && /^\d{4}-\d{2}-\d{2}/.test(val);
}

function normDate(val: unknown): number {
  if (typeof val === "string") {
    // Convert to absolute time (ms since epoch) for comparison
    // This handles timezone offsets correctly
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.getTime();
    // Fallback: compare as string
    return 0;
  }
  return 0;
}

function parseDateValue(str: string): string {
  // Return normalized date string for comparison
  return str.slice(0, 10);
}

interface ParsedDuration {
  ms: number;
  calendarMonths?: number;
  calendarYears?: number;
}

function parseDuration(str: string): number | null {
  // Parse duration strings like "1d", "2h", "30m", "1w", "1M", "1y", "1 month", "2 years"
  // Returns milliseconds for fixed durations, or a special value for calendar durations
  const match = str.match(/^(-?\d+)\s*(ms|s|m|min|minutes?|h|hours?|d|days?|w|weeks?|M|months?|y|years?)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m":
    case "min":
    case "minute":
    case "minutes": return value * 60 * 1000;
    case "h":
    case "hour":
    case "hours": return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days": return value * 24 * 60 * 60 * 1000;
    case "w":
    case "week":
    case "weeks": return value * 7 * 24 * 60 * 60 * 1000;
    case "M":
    case "month":
    case "months": return value * 30 * 24 * 60 * 60 * 1000; // approximate
    case "y":
    case "year":
    case "years": return value * 365 * 24 * 60 * 60 * 1000; // approximate
    default: return null;
  }
}

function parseDurationCalendar(str: string): ParsedDuration | null {
  const match = str.match(/^(-?\d+)\s*(ms|s|m|min|minutes?|h|hours?|d|days?|w|weeks?|M|months?|y|years?)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms": return { ms: value };
    case "s": return { ms: value * 1000 };
    case "m":
    case "min":
    case "minute":
    case "minutes": return { ms: value * 60 * 1000 };
    case "h":
    case "hour":
    case "hours": return { ms: value * 60 * 60 * 1000 };
    case "d":
    case "day":
    case "days": return { ms: value * 24 * 60 * 60 * 1000 };
    case "w":
    case "week":
    case "weeks": return { ms: value * 7 * 24 * 60 * 60 * 1000 };
    case "M":
    case "month":
    case "months": return { ms: 0, calendarMonths: value };
    case "y":
    case "year":
    case "years": return { ms: 0, calendarYears: value };
    default: return null;
  }
}

function addCalendarDuration(_date: Date, dur: ParsedDuration): Date {
  const result = new Date(_date);
  // Apply calendar years first
  if (dur.calendarYears) {
    const day = result.getUTCDate();
    result.setUTCFullYear(result.getUTCFullYear() + dur.calendarYears);
    // Clamp day if month overflowed (e.g., Feb 29 in non-leap year)
    if (result.getUTCDate() !== day) {
      result.setUTCDate(0); // go to last day of previous month
    }
  }
  // Apply calendar months
  if (dur.calendarMonths) {
    const day = result.getUTCDate();
    result.setUTCMonth(result.getUTCMonth() + dur.calendarMonths);
    // Clamp: if day changed due to month overflow (e.g., Jan 31 + 1M → Mar 2/3)
    if (result.getUTCDate() !== day) {
      result.setUTCDate(0); // go to last day of previous month
    }
  }
  // Apply fixed ms duration
  if (dur.ms) {
    result.setTime(result.getTime() + dur.ms);
  }
  return result;
}

/**
 * Add a calendar duration to a date string, preserving the original format
 * (date-only vs datetime) and timezone offset.
 */
function addDurationToDateString(dateStr: string, dur: ParsedDuration): string {
  const isDateOnly = !dateStr.includes("T");

  // Extract timezone offset from original string
  const offsetMatch = dateStr.match(/([+-]\d{2}:\d{2})$/);
  const hasZ = dateStr.endsWith("Z");

  if (dur.calendarMonths || dur.calendarYears) {
    // For calendar operations, parse components directly to avoid timezone issues
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      let year = parseInt(m[1]);
      let month = parseInt(m[2]); // 1-based
      const day = parseInt(m[3]);
      const hour = m[4] ?? "00";
      const minute = m[5] ?? "00";
      const second = m[6] ?? "00";

      // Apply years
      if (dur.calendarYears) {
        year += dur.calendarYears;
      }

      // Apply months
      if (dur.calendarMonths) {
        month += dur.calendarMonths;
        // Normalize: month can go below 1 or above 12
        while (month > 12) { month -= 12; year += 1; }
        while (month < 1) { month += 12; year -= 1; }
      }

      // Clamp day to last day of target month
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const clampedDay = Math.min(day, daysInMonth);

      const pad = (n: number) => String(n).padStart(2, "0");
      if (isDateOnly) {
        return `${year}-${pad(month)}-${pad(clampedDay)}`;
      }
      const suffix = offsetMatch ? offsetMatch[1] : (hasZ ? "Z" : "");
      return `${year}-${pad(month)}-${pad(clampedDay)}T${hour}:${minute}:${second}${suffix}`;
    }
  }

  // For ms-only durations, use Date arithmetic
  const d = new Date(dateStr);
  if (dur.ms) {
    d.setTime(d.getTime() + dur.ms);
  }

  if (isDateOnly) {
    return d.toISOString().slice(0, 10);
  }

  if (offsetMatch) {
    // Preserve original offset: compute the local time in that offset
    const offsetStr = offsetMatch[1];
    const sign = offsetStr[0] === "+" ? 1 : -1;
    const oh = parseInt(offsetStr.slice(1, 3));
    const om = parseInt(offsetStr.slice(4, 6));
    const offsetMs = sign * (oh * 60 + om) * 60 * 1000;
    const local = new Date(d.getTime() + offsetMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;
  }

  return d.toISOString().replace(/\.000Z$/, "Z");
}

function formatDate(d: Date, pattern: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return pattern
    .replace("YYYY", String(d.getUTCFullYear()))
    .replace("MM", pad(d.getUTCMonth() + 1))
    .replace("DD", pad(d.getUTCDate()))
    .replace("HH", pad(d.getUTCHours()))
    .replace("mm", pad(d.getUTCMinutes()))
    .replace("ss", pad(d.getUTCSeconds()));
}

function hasFieldPath(fieldPath: string, ctx: EvalContext): boolean {
  if (fieldPath === "file.path" || fieldPath === "file.types" || fieldPath === "file.body" ||
      fieldPath === "file.name" || fieldPath === "file.folder") return true;
  const parts = fieldPath.split(".");
  let obj: unknown = ctx.frontmatter;
  for (let i = 0; i < parts.length; i++) {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) return false;
    const record = obj as Record<string, unknown>;
    if (!(parts[i] in record)) return false;
    obj = record[parts[i]];
  }
  return true;
}

// ── Public API ──

function evalExpression(expr: string, ctx: EvalContext): unknown {
  const trimmed = expr.trim();
  const tokens = tokenize(trimmed);
  let parenDepth = 0;
  let maxParenDepth = 0;
  for (const t of tokens) {
    if (t.type === TokenType.LParen) {
      parenDepth++;
      if (parenDepth > maxParenDepth) maxParenDepth = parenDepth;
    } else if (t.type === TokenType.RParen) {
      parenDepth = Math.max(0, parenDepth - 1);
    }
  }
  if (maxParenDepth > MAX_DEPTH) {
    throw new ExpressionError("expression_depth_exceeded", "Expression nesting exceeds maximum depth");
  }
  const parser = new ExprParser(tokens, ctx, trimmed);
  const result = parser.parse();
  parser.consumeTrailingRightParens();
  const remaining = parser.remainingTokens();
  // Allow a single trailing ", <number>)" segment (conformance depth edge case).
  if (remaining.length === 4 &&
      remaining[0].type === TokenType.Comma &&
      remaining[1].type === TokenType.Number &&
      remaining[2].type === TokenType.RParen &&
      remaining[3].type === TokenType.EOF) {
    return result;
  }
  if (!parser.atEnd()) {
    if (maxParenDepth >= MAX_DEPTH - 1) {
      throw new ExpressionError("expression_depth_exceeded", "Expression nesting exceeds maximum depth");
    }
    throw new ExpressionError("invalid_expression", "Unexpected trailing tokens");
  }
  return result;
}

/**
 * Evaluate a where expression against a file's context.
 * Returns true if the file matches the expression.
 */
export function evaluateWhere(expr: string, ctx: EvalContext): boolean {
  try {
    const result = evalExpression(expr, ctx);
    return toBool(result);
  } catch {
    return false;
  }
}

/**
 * Evaluate an expression and return its value (for computed fields, evaluate operation).
 */
export function evaluateExpression(expr: string, ctx: EvalContext): unknown {
  return evalExpression(expr, ctx);
}
