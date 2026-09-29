// T-L7: citation labels from .bib files (src/tex/bib.ts, design 4.5): names (et al., braces,
// accents, Chinese names, `von`), years from `year` or `date`, BibTeX syntax (@string, quotes,
// `#`, parentheses, comments), the files a project names, and the mtime/buffer cache. Synthetic
// entries only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bibFiles, citeLabel, parseBib, readBib } from "../src/tex/bib";

const labels = (text: string) => Object.fromEntries([...parseBib(text)].map(([k, e]) => [k, citeLabel(e)]));

test("T-L7 the fixture's refs.bib: Chinese names, three authors, a date field", () => {
  const bib = parseBib(readFileSync(resolve("tests/fixtures/elegantbook/refs.bib"), "utf8"));
  assert.deepEqual(Object.fromEntries([...bib].map(([k, e]) => [k, citeLabel(e)])), {
    zhang2020notes: "张三、李四 2020",
    li2019lln: "Li et al. 2019",
  });
  const li = bib.get("li2019lln")!;
  assert.deepEqual([li.type, li.names, li.others, li.year], ["article", ["Li", "Doe", "Roe"], false, "2019"]);
  assert.equal(li.title, "A Toy Proof of the Strong Law of Large Numbers");
  assert.equal(bib.get("zhang2020notes")!.title, "概率论讲义（示例版）");
});

test("T-L7 names: Last, First; First von Last; braces protect; accents; others; editors; none", () => {
  assert.deepEqual(
    labels(`
@article{one, author = {Wang, Wu}, year = 2022}
@article{two, author = {Alex Smith and Richard Roe}, year = {2021}}
@article{von, author = {Ludwig van Beethoven and de la Fontaine, Jean}, year = {1801}}
@article{corp, author = {{Barnes and Noble} and {World Health Organization}}, year = {2020}}
@article{accents, author = {M{\\"u}ller, J{\\"o}rg and Andr\\'{e} Gide and {\\v{S}}koda, Emil}, year = {1990}}
@article{others, author = {Doe, Jane and others}, year = {2019}}
@book{edited, editor = {Example, Ellen}, date = {2024-05-01}}
@online{anon, title = {An Online Resource That Does Not Exist Anywhere At All}, date = {2019/2020}}
@misc{bare}
@article{wang3, author = {王五 and 赵六 and 钱七}, year = {2022}}
@article{mixed, author = {张三}, year = {2020}}
`),
    {
      one: "Wang 2022",
      two: "Smith and Roe 2021",
      von: "Beethoven and Fontaine 1801",
      corp: "Barnes and Noble and World Health Organization 2020",
      accents: "Müller et al. 1990",
      others: "Doe et al. 2019",
      edited: "Example 2024",
      anon: "An Online Resource That Does Not Exist… 2019",
      bare: "bare",
      wang3: "王五等 2022",
      mixed: "张三 2020",
    },
  );
});

test("T-L7 syntax: @string, quotes, `#`, months, parentheses, comments, duplicates, malformed entries", () => {
  const bib = parseBib(`
Text outside entries is a comment (BibTeX has no % comments).
@comment{ @article{commented, author = {Hidden}} }
@preamble{ "\\newcommand{\\noop}[1]{}" }
@string{ acm = "ACM Press" }
@STRING(jd = {Jane Doe})
@Article(paren,
  author = jd # " and Roe, Richard",
  title  = "A {Title} with " # acm,
  month  = mar,
  year   = "2018"
)
@article{dup, author = {First, A}, year = 2001}
@article{dup, author = {Second, B}, year = 2002}
@article{broken author = {X}, year = 1999}
@article{afterBroken, author = {Last, Z}, year = {1998},}
@article{ spaced ,
  author = {Doe, J},
  year = {1997}
}
`);
  assert.ok(!bib.has("commented"), "@comment's content");
  const paren = bib.get("paren")!;
  assert.deepEqual([paren.names, paren.year, paren.title], [["Doe", "Roe"], "2018", "A Title with ACM Press"]);
  assert.equal(citeLabel(bib.get("dup")!), "First 2001", "the first entry of a key wins");
  assert.equal(bib.has("broken"), false, "a key with `=` in it is not a key");
  assert.equal(citeLabel(bib.get("afterBroken")!), "Last 1998");
  assert.equal(citeLabel(bib.get("spaced")!), "Doe 1997");
});

test("T-L7 bibFiles: \\addbibresource and \\bibliography of the project's sources, resolved and in order", () => {
  const files = bibFiles(
    [
      "\\addbibresource{refs.bib}\n% \\addbibresource{commented.bib}\n\\addbibresource[location=remote]{https://example.com/x.bib}\n\\addglobalbib{more}",
      "\\bibliographystyle{plainnat}\n\\bibliography{a, sub/b.bib}\n\\nobibliography{refs}",
    ],
    "/book",
  );
  assert.deepEqual(files, ["/book/refs.bib", "/book/more.bib", "/book/a.bib", "/book/sub/b.bib"]);
});

test("T-L7 readBib: re-parsed when the file changes, unsaved buffers win, missing files are empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-bib-"));
  try {
    const path = join(dir, "refs.bib");
    writeFileSync(path, "@book{k, author = {Old, A}, year = 2000}");
    const first = readBib(path);
    assert.equal(citeLabel(first.get("k")!), "Old 2000");
    assert.equal(readBib(path), first, "cached by mtime");
    writeFileSync(path, "@book{k, author = {New, B}, year = 2001}");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    assert.equal(citeLabel(readBib(path).get("k")!), "New 2001");
    const buffer = "@book{k, author = {Typed, C}, year = 2002}";
    assert.equal(citeLabel(readBib(path, buffer).get("k")!), "Typed 2002");
    assert.equal(readBib(path, buffer), readBib(path, buffer), "cached per buffer text");
    assert.equal(readBib(join(dir, "missing.bib")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
