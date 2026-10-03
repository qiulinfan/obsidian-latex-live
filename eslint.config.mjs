import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import sdl from "@microsoft/eslint-plugin-sdl";

// Every error-level official plugin rule, plus the SDL HTML blocker. Advisory findings
// (including browser timers in pure Node TeX services) have separate constraints.
const official = Object.assign({}, ...obsidianmd.configs.recommended.map((config) => config.rules ?? {}));
const blockers = Object.fromEntries(Object.entries(official).filter(([name, setting]) => {
  const severity = Array.isArray(setting) ? setting[0] : setting;
  return name.startsWith("obsidianmd/") && (severity === "error" || severity === 2);
}));
export default [{
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  plugins: { obsidianmd, "@microsoft/sdl": sdl },
  rules: {
    "@microsoft/sdl/no-inner-html": "error",
    ...blockers,
  },
}];
