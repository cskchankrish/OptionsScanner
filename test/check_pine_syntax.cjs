const fs = require("fs");
const path = require("path");

const files = [
  "strategy_dashboard_v4_3_real_oi.pine",
  "strategy_dashboard_v4_4_backtest_strategy.pine"
];

for (const file of files) {
  const filePath = path.join(__dirname, "..", file);
  const content = fs.readFileSync(filePath, "utf8");
  console.log(`\n=== Checking ${file} ===`);
  console.log(`Lines: ${content.split("\n").length}, Size: ${content.length} bytes`);

  let parens = 0, brackets = 0, braces = 0;
  let inString = false, strChar = "";
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if ((ch === '"' || ch === "'") && line[c - 1] !== "\\") {
        if (!inString) {
          inString = true;
          strChar = ch;
        } else if (strChar === ch) {
          inString = false;
        }
      } else if (!inString) {
        if (ch === "/" && line[c + 1] === "/") {
          break; // Rest of line is comment
        }
        if (ch === "(") parens++;
        else if (ch === ")") parens--;
        else if (ch === "[") brackets++;
        else if (ch === "]") brackets--;
        else if (ch === "{") braces++;
        else if (ch === "}") braces--;
      }
    }

    if (parens < 0 || brackets < 0 || braces < 0) {
      console.error(`ERROR at line ${i + 1}: Unbalanced closing delimiter! parens=${parens}, brackets=${brackets}, braces=${braces}`);
      console.error(`Line: ${line}`);
      process.exit(1);
    }
  }

  if (parens !== 0 || brackets !== 0 || braces !== 0) {
    console.error(`ERROR: Final unbalanced delimiters in ${file}! parens=${parens}, brackets=${brackets}, braces=${braces}`);
    process.exit(1);
  }

  console.log(`PASS: All parentheses, brackets, and braces are 100% balanced in ${file}!`);
}
