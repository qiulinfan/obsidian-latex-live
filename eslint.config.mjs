import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import sdl from "@microsoft/eslint-plugin-sdl";

// Release-blocking checks from the community review. Advisory findings (including
// browser timers in pure Node TeX services) have separate architectural constraints.
export default [{
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { obsidianmd, "@microsoft/sdl": sdl },
  rules: {
    "@microsoft/sdl/no-inner-html": "error",
    "obsidianmd/no-static-styles-assignment": "error",
  },
}];
