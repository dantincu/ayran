import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayUrl, normalizeUrl, secondLevelDomain, matchLevel } from '../src/shared/urls.js';

test('displayUrl drops the protocol', () => {
  assert.equal(displayUrl('https://www.example.com/a?b#c'), 'www.example.com/a?b#c');
  assert.equal(displayUrl('http://example.com'), 'example.com');
  assert.equal(displayUrl('chrome://settings/'), 'settings/');
  assert.equal(displayUrl('about:blank'), 'blank');
  assert.equal(displayUrl(''), '');
});

test('normalizeUrl ignores redundant slashes, lone ? and #', () => {
  const base = normalizeUrl('https://example.com/a/b');
  for (const u of [
    'https://example.com/a/b/',
    'https://example.com//a///b',
    'https://example.com/a/b?',
    'https://example.com/a/b#',
    'https://example.com/a/b/?#',
  ]) {
    assert.equal(normalizeUrl(u), base, u);
  }
  assert.equal(normalizeUrl('https://example.com'), normalizeUrl('https://example.com/'));
  assert.notEqual(normalizeUrl('https://example.com/a?x=1'), base);
  assert.notEqual(normalizeUrl('https://example.com/a#top'), normalizeUrl('https://example.com/a'));
});

test('secondLevelDomain', () => {
  assert.equal(secondLevelDomain('mail.google.com'), 'google.com');
  assert.equal(secondLevelDomain('google.com'), 'google.com');
  assert.equal(secondLevelDomain('a.b.c.example.org'), 'example.org');
  assert.equal(secondLevelDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(secondLevelDomain('localhost'), 'localhost');
  assert.equal(secondLevelDomain('192.168.0.1'), '192.168.0.1');
  assert.equal(secondLevelDomain('WWW.Example.COM.'), 'example.com');
});

test('matchLevel', () => {
  const u = 'https://docs.example.com/guide/intro';
  assert.equal(matchLevel(u, u), 'exact');
  assert.equal(matchLevel(u, 'https://docs.example.com/guide//intro/'), 'equal');
  assert.equal(matchLevel(u, 'https://docs.example.com/guide/intro?#'), 'equal');
  assert.equal(matchLevel(u, 'https://docs.example.com/other'), 'domain');
  assert.equal(matchLevel(u, 'https://www.example.com/'), 'sld');
  assert.equal(matchLevel(u, 'https://example.org/'), null);
  assert.equal(matchLevel(u, 'https://bbc.co.uk/'), null);
  assert.equal(matchLevel('https://a.bbc.co.uk/', 'https://b.bbc.co.uk/'), 'sld');
  assert.equal(matchLevel('https://a.bbc.co.uk/', 'https://a.other.co.uk/'), null);
  assert.equal(matchLevel('file:///C:/a.txt', 'file:///C:/b.txt'), 'sld');
  assert.equal(matchLevel(u, ''), null);
});
