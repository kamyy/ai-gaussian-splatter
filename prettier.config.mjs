/** @type {import("prettier").Config} */
export default {
  // Uses TypeScript's organize imports (same as VS Code source.organizeImports)
  plugins: ["prettier-plugin-organize-imports"],

  // Line formatting
  printWidth: 120, // wrap lines longer than this many characters
  tabWidth: 2, // spaces per indentation level
  useTabs: false, // indent with spaces, not tab characters

  // Quotes and commas
  singleQuote: false, // "like this" instead of 'like this' (Prettier default)
  trailingComma: "all", // trailing comma wherever valid, including function args
  semi: true, // semicolons at the end of statements (Prettier default)

  // Brackets and spacing
  bracketSpacing: true, // { foo: bar } instead of {foo: bar}
  bracketSameLine: false, // multiline JSX/HTML closing `>` on its own line
  arrowParens: "avoid", // x => x instead of (x) => x for single-param arrows

  // Line endings
  endOfLine: "lf", // Unix line endings, not CRLF
};
