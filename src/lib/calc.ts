/** A small, safe arithmetic evaluator. It never runs JavaScript: only numbers, operators, and listed functions. */

const FUNCTIONS: Record<string, (...values: number[]) => number> = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  log: (x) => Math.log10(x),
  ln: (x) => Math.log(x),
  min: (...values) => Math.min(...values),
  max: (...values) => Math.max(...values),
  pow: (x, y) => x ** y,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { type: "num" | "id" | "op"; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) { index++; continue; }
    const number = input.slice(index).match(/^\d+(\.\d+)?/);
    if (number) { tokens.push({ type: "num", value: number[0] }); index += number[0].length; continue; }
    const word = input.slice(index).match(/^[a-zA-Z]+/);
    if (word) { tokens.push({ type: "id", value: word[0].toLowerCase() }); index += word[0].length; continue; }
    if ("+-*/%^(),".includes(char)) { tokens.push({ type: "op", value: char }); index++; continue; }
    throw new Error(`Unexpected character “${char}”. Use numbers, + - * / % ^, parentheses, and functions such as sqrt(16).`);
  }
  return tokens;
}

export function evaluate(expression: string): number {
  if (!expression.trim()) throw new Error("Give an expression, such as calc 12 * (3 + 4).");
  if (expression.length > 200) throw new Error("That expression is too long.");
  const tokens = lex(expression);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (value: string) => {
    const token = take();
    if (!token || token.value !== value) throw new Error(`Expected “${value}”.`);
  };

  function primary(): number {
    const token = take();
    if (!token) throw new Error("The expression ends too early.");
    if (token.type === "num") return Number(token.value);
    if (token.type === "op" && token.value === "(") { const value = sum(); expect(")"); return value; }
    if (token.type === "op" && token.value === "-") return -unary();
    if (token.type === "op" && token.value === "+") return unary();
    if (token.type === "id") {
      if (peek()?.value === "(") {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error(`Unknown function “${token.value}”.`);
        take();
        const args: number[] = [sum()];
        while (peek()?.value === ",") { take(); args.push(sum()); }
        expect(")");
        return fn(...args);
      }
      if (token.value in CONSTANTS) return CONSTANTS[token.value];
      throw new Error(`Unknown name “${token.value}”.`);
    }
    throw new Error(`Unexpected “${token.value}”.`);
  }
  function unary(): number { return primary(); }
  function power(): number {
    const base = unary();
    if (peek()?.value === "^") { take(); return base ** power(); }
    return base;
  }
  function product(): number {
    let value = power();
    while (peek()?.value === "*" || peek()?.value === "/" || peek()?.value === "%") {
      const op = take().value;
      const right = power();
      if (op === "*") value *= right;
      else if (op === "/") { if (right === 0) throw new Error("Division by zero."); value /= right; }
      else { if (right === 0) throw new Error("Division by zero."); value %= right; }
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (peek()?.value === "+" || peek()?.value === "-") {
      const op = take().value;
      const right = product();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  const result = sum();
  if (position < tokens.length) throw new Error(`Unexpected “${tokens[position].value}”.`);
  if (!Number.isFinite(result)) throw new Error("The result is not a finite number.");
  return Math.round(result * 1e10) / 1e10;
}
