import { describe, expect, it } from 'vitest';
import { MAX_CODEOWNERS_BYTES, parseCodeowners } from '../src/codeowners.js';

describe('parseCodeowners', () => {
  it('reads users, teams and e-mails, lower-cases, and ignores comments and blank lines', () => {
    const p = parseCodeowners(
      [
        '# Owners',
        '',
        '*       @Alice @acme/Core-Team',
        '*.js    @bob   # trailing comment',
        'docs/   docs@example.com',
        '/build/logs/ @alice',
        '   ',
        '\t# indented comment',
      ].join('\n'),
    );
    expect(p.errors).toEqual([]);
    expect(p.rules.map((r) => [r.line, r.pattern, r.owners.length])).toEqual([
      [3, '*', 2],
      [4, '*.js', 1],
      [5, 'docs/', 1],
      [6, '/build/logs/', 1],
    ]);
    expect(p.owners).toEqual([
      { kind: 'email', email: 'docs@example.com' },
      { kind: 'team', org: 'acme', slug: 'core-team' },
      { kind: 'user', login: 'alice' },
      { kind: 'user', login: 'bob' },
    ]);
  });

  it('handles CRLF and CR line endings', () => {
    expect(parseCodeowners('* @a\r\n*.md @b\r\n').owners).toHaveLength(2);
    expect(parseCodeowners('* @a\r*.md @b').owners).toHaveLength(2);
  });

  it('a pattern with no owners is legal and clears ownership of that pattern', () => {
    const p = parseCodeowners('* @a\n/vendor/\n');
    expect(p.errors).toEqual([]);
    expect(p.rules[1]).toMatchObject({ pattern: '/vendor/', owners: [] });
    expect(p.owners).toEqual([{ kind: 'user', login: 'a' }]);
  });

  it('a later rule with the same pattern replaces the earlier one', () => {
    const p = parseCodeowners('*.js @old\n*.md @keep\n*.js @new\n');
    expect(p.rules).toHaveLength(3);
    expect(p.effective.map((r) => r.pattern)).toEqual(['*.md', '*.js']);
    expect(p.owners).toEqual([
      { kind: 'user', login: 'keep' },
      { kind: 'user', login: 'new' },
    ]);
  });

  it('supports escaped characters in the pattern', () => {
    const p = parseCodeowners('\\#file.txt @a\nmy\\ dir/ @b\n');
    expect(p.errors).toEqual([]);
    expect(p.rules.map((r) => r.pattern)).toEqual(['#file.txt', 'my dir/']);
  });

  it('records unparseable lines as errors, skips them, and keeps the rest', () => {
    const p = parseCodeowners(
      [
        '* @good',
        '*.js not-an-owner',
        '*.py @bad_login!',
        '*.rb @acme/team/extra',
        '!negated @x',
        '[Section] @x',
        'src/[ab].ts @x',
        '*.go @-leading',
        'trail\\',
        '*.ok @fine',
      ].join('\n'),
    );
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p.errors.find((e) => e.line === 5)?.message).toMatch(/"!"/);
    expect(p.owners).toEqual([
      { kind: 'user', login: 'fine' },
      { kind: 'user', login: 'good' },
    ]);
    // A line with one bad owner is skipped whole, not half-used.
    expect(parseCodeowners('* @a bad').owners).toEqual([]);
  });

  it('never executes or expands anything: shell syntax is just text and an invalid owner', () => {
    const p = parseCodeowners('* $(touch /tmp/pwned) @a\n`rm -rf /` @b\n');
    expect(p.owners).toEqual([]);
    expect(p.errors).toHaveLength(2);
  });

  it('refuses a file over 3 MiB as a whole', () => {
    const big = `* @a\n${'#'.repeat(MAX_CODEOWNERS_BYTES)}\n`;
    const p = parseCodeowners(big);
    expect(p.owners).toEqual([]);
    expect(p.errors[0]?.message).toMatch(/3 MiB/);
  });

  it('is fast on a hostile line', () => {
    const t = Date.now();
    parseCodeowners(`${'\\'.repeat(100_000)} @a\n${'a '.repeat(100_000)}\n`);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
