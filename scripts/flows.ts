// Draws every end-to-end scenario as a draw.io flow, straight from the test names, so the diagrams
// cannot drift from what the tests prove. `npm run flows` writes docs/flows/; `--check` fails when
// they are stale (CI); `--export` also renders PNGs with the draw.io desktop app, if installed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scenarios = join(root, 'test', 'e2e');
const out = join(root, 'docs', 'flows');
const check = process.argv.includes('--check');
const exportPng = process.argv.includes('--export');

type Lane = 'agent' | 'person' | 'relay';
const LANES: Record<Lane, { title: string; x: number; fill: string; stroke: string }> = {
  agent: { title: 'Agent (MCP client)', x: 40, fill: '#dae8fc', stroke: '#6c8ebf' },
  person: { title: 'Person (browser)', x: 360, fill: '#d5e8d4', stroke: '#82b366' },
  relay: { title: 'Relay', x: 680, fill: '#fff2cc', stroke: '#d6b656' },
};
const GUARD = { fill: '#f8cecc', stroke: '#b85450' };
const WIDTH = 280;
const HEIGHT = 80;
const GAP = 40;

/** Test titles in source order: the first describe() is the flow, every it() a step. */
function titles(source: string): { flow: string; steps: string[] } {
  const literal = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\`((?:[^\`\\]|\\.)*)\`)`;
  const pick = (m: RegExpMatchArray) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  const flow = source.match(new RegExp(String.raw`\bdescribe\(\s*${literal}`));
  const steps = [...source.matchAll(new RegExp(String.raw`\bit\(\s*${literal}`, 'g'))].map(pick);
  return { flow: flow ? pick(flow) : '', steps };
}

/** Who acts in a step, read from its wording. */
function lane(step: string): Lane {
  const start = step.split(/\s+/).slice(0, 4).join(' ');
  if (/\bagents?\b|\bMCP\b|\btoken\b|\binbox\b/i.test(start)) return 'agent';
  if (/\b(browser|page|dashboard|clicks?|types?|signs? in|reads?|sees?|opens?|invites?|joins?|confirms?|removes?)\b/i.test(step)) return 'person';
  if (/\bagents?\b/i.test(step)) return 'agent';
  return 'relay';
}

/** Steps that prove something cannot happen get the guard colour. */
const guard = (step: string) =>
  /\b(cannot|can't|never|refus\w*|does nothing|shares nothing|finds nothing|stops?|no longer|carr(?:y|ies) no|not valid|neutral page)\b/i.test(step);

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function diagram(name: string, flow: string, steps: string[]): string {
  const cells: string[] = [];
  const top = 120;
  const height = top + steps.length * (HEIGHT + GAP) + 40;
  cells.push(
    `<mxCell id="title" value="${xml(flow)}" style="text;html=1;fontSize=16;fontStyle=1;align=left;verticalAlign=middle;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="40" y="10" width="920" height="40" as="geometry"/></mxCell>`,
  );
  for (const [key, l] of Object.entries(LANES)) {
    cells.push(
      `<mxCell id="lane-${key}" value="${xml(l.title)}" style="swimlane;html=1;startSize=30;fillColor=${l.fill};strokeColor=${l.stroke};swimlaneFillColor=none;" vertex="1" parent="1"><mxGeometry x="${l.x - 20}" y="60" width="${WIDTH + 40}" height="${height - 60}" as="geometry"/></mxCell>`,
    );
  }
  steps.forEach((step, i) => {
    const l = LANES[lane(step)];
    const colours = guard(step) ? GUARD : l;
    cells.push(
      `<mxCell id="s${i}" value="${xml(`${i + 1}. ${step}`)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${colours.fill};strokeColor=${colours.stroke};fontSize=12;" vertex="1" parent="1"><mxGeometry x="${l.x}" y="${top + i * (HEIGHT + GAP)}" width="${WIDTH}" height="${HEIGHT}" as="geometry"/></mxCell>`,
    );
    if (i > 0) {
      cells.push(
        `<mxCell id="e${i}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;" edge="1" parent="1" source="s${i - 1}" target="s${i}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
      );
    }
  });
  return `<mxfile host="klatsch" type="device">
  <diagram id="${xml(name)}" name="${xml(name)}">
    <mxGraphModel dx="1000" dy="${height}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1000" pageHeight="${height}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

const files = readdirSync(scenarios).filter((f) => f.endsWith('.e2e.ts')).sort();
const index: string[] = [
  '# Klatsch flows',
  '',
  'Generated from the end-to-end scenarios in `test/e2e/` by `npm run flows`; do not edit by hand. Open a `.drawio` file in draw.io (desktop or app.diagrams.net). Lanes show who acts; red boxes are steps that prove something cannot happen.',
  '',
  '| Flow | Steps | Diagram |',
  '|---|---|---|',
];
let stale = 0;
mkdirSync(out, { recursive: true });
for (const file of files) {
  const name = basename(file, '.e2e.ts');
  const { flow, steps } = titles(readFileSync(join(scenarios, file), 'utf8'));
  if (!steps.length) continue;
  index.push(`| ${flow} | ${steps.length} | [${name}.drawio](${name}.drawio) |`);
  const path = join(out, `${name}.drawio`);
  const content = diagram(name, flow, steps);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
      console.error(`stale: docs/flows/${name}.drawio`);
      stale++;
    }
    continue;
  }
  writeFileSync(path, content);
  if (exportPng) {
    const app = '/Applications/draw.io.app/Contents/MacOS/draw.io';
    if (existsSync(app)) execFileSync(app, ['--export', '--format', 'png', '--scale', '1', '--output', join(out, `${name}.png`), path], { stdio: 'ignore' });
  }
}
const readme = `${index.join('\n')}\n`;
if (check) {
  if (!existsSync(join(out, 'README.md')) || readFileSync(join(out, 'README.md'), 'utf8') !== readme) {
    console.error('stale: docs/flows/README.md');
    stale++;
  }
  if (stale) {
    console.error('Run `npm run flows` and commit the result.');
    process.exit(1);
  }
} else {
  writeFileSync(join(out, 'README.md'), readme);
}
