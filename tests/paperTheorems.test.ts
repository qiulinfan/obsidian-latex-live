// Springer LNCS 2.26's built-ins and native census contracts; none uses amsthm's proof API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { censusTheorems, profileOf, theoremLook } from "../src/export/profiles";
import { theoremMap } from "../src/tex/theorems";

test("LNCS native theorem map: independent/alias counters are not guessed, proof and claim accept parenthesized titles", () => {
  for (const options of ["", "envcountsect", "envcountsame", "envcountsame,envcountsect", "envcountreset"]) {
    const map = theoremMap([`\\documentclass[${options}]{llncs}`]);
    assert.equal(map.size, 17);
    for (const [env, def] of map) {
      assert.equal(def.numbered, !["proof", "claim"].includes(env));
      assert.equal(def.spec, "o");
      assert.equal(def.title, "paren");
      assert.equal(def.punct, ".");
      assert.equal(def.counter, null, "unlabelled live heads need chapter-qualified evidence the class does not provide");
      assert.equal(def.qed, null, "native LNCS proof has no automatic QED");
      assert.equal(def.nameMacro, true);
    }
  }
  assert.equal(theoremMap([String.raw`\documentclass[deutsch]{llncs}`]).get("proof")!.name, "Beweis");
  assert.equal(theoremMap([String.raw`\documentclass[francais]{llncs}`]).get("definition")!.name, "Définition");
  assert.equal(theoremMap([String.raw`\documentclass{amsart}`]).get("proof")!.title, "replace", "AMS retains its separate proof contract");
  const declared = theoremMap([String.raw`\documentclass{llncs}\spnewtheorem{statement}{Statement}{\bfseries}{\itshape}\spnewtheorem*{sketch}{Sketch}{\itshape}{\rmfamily}\spnewtheorem{unknownfont}{Unknown}{\sffamily}{\rmfamily}\spnewtheorem{mathhead}{A $G$}{\bfseries}{\itshape}`]);
  assert.equal(declared.get("statement")!.name, "Statement");
  assert.equal(declared.get("sketch")!.numbered, false);
  assert.equal(declared.has("unknownfont"), false);
  assert.equal(declared.has("mathhead"), false, "a math caption remains a native TeX fragment");
});

test("Springer @spthm/@Thm census: native head/body fonts, optional title font and unsupported custom fonts", () => {
  const envs = new Map([
    ["statement", String.raw`macro:->\@spthm {statement}{\csname statementname\endcsname}{\bfseries}{\itshape}`],
    ["example", String.raw`macro:->\@spthm {example}{Example}{\itshape}{\rmfamily}`],
    ["sketch", String.raw`macro:->\@Thm {Sketch}{\itshape}{\rmfamily}`],
    ["unsupported", String.raw`macro:->\@spthm {unsupported}{Unsupported}{\sffamily}{\rmfamily}`],
    ["complex-title", String.raw`macro:->\@spthm {complex}{\someTypesetter}{\bfseries}{\itshape}`],
  ]);
  const defs = censusTheorems(envs, new Map(), new Map([["statement", "Statement"]]));
  assert.deepEqual([...defs.keys()], ["statement", "example", "sketch"]);
  assert.deepEqual([...defs].map(([name, def]) => [name, def.name, def.numbered, def.counter, def.title, def.punct]), [["statement", "Statement", true, "statement", "paren", "."], ["example", "Example", true, "example", "paren", "."], ["sketch", "Sketch", false, null, "paren", "."]]);
  const profile = profileOf(String.raw`\documentclass{llncs}`, []);
  assert.deepEqual(["statement", "example", "sketch"].map((env) => {
    const look = theoremLook(profile, env, defs.get(env)!, envs.get(env));
    return [look.head, look.note, look.body];
  }), [["bold", "head", "it"], ["italic", "head", ""], ["italic", "head", ""]]);
});
