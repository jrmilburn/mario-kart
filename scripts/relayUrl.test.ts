import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRelayUrl } from '../src/shared/relayUrl';

const HTTP_FALLBACK = { protocol: 'http:', host: 'example.com' };
const HTTPS_FALLBACK = { protocol: 'https:', host: 'example.com' };

test('resolveRelayUrl: unset/empty falls back to same-origin /ws', () => {
  assert.equal(resolveRelayUrl(undefined, HTTP_FALLBACK), 'ws://example.com/ws');
  assert.equal(resolveRelayUrl(null, HTTPS_FALLBACK), 'wss://example.com/ws');
  assert.equal(resolveRelayUrl('', HTTP_FALLBACK), 'ws://example.com/ws');
  assert.equal(resolveRelayUrl('   ', HTTP_FALLBACK), 'ws://example.com/ws');
});

test('resolveRelayUrl: ws(s)://host gets /ws appended', () => {
  assert.equal(resolveRelayUrl('wss://relay.example', HTTP_FALLBACK), 'wss://relay.example/ws');
  assert.equal(resolveRelayUrl('ws://relay.example', HTTP_FALLBACK), 'ws://relay.example/ws');
  assert.equal(resolveRelayUrl('wss://relay.example/', HTTP_FALLBACK), 'wss://relay.example/ws');
});

test('resolveRelayUrl: ws(s)://host/ws is left unchanged', () => {
  assert.equal(resolveRelayUrl('wss://relay.example/ws', HTTP_FALLBACK), 'wss://relay.example/ws');
});

test('resolveRelayUrl: http(s) is mapped to ws(s)', () => {
  assert.equal(resolveRelayUrl('https://relay.example', HTTP_FALLBACK), 'wss://relay.example/ws');
  assert.equal(resolveRelayUrl('http://relay.example', HTTP_FALLBACK), 'ws://relay.example/ws');
  assert.equal(resolveRelayUrl('https://relay.example/ws', HTTP_FALLBACK), 'wss://relay.example/ws');
});

test('resolveRelayUrl: bare host borrows the scheme family from the page', () => {
  assert.equal(resolveRelayUrl('relay.example', HTTP_FALLBACK), 'ws://relay.example/ws');
  assert.equal(resolveRelayUrl('relay.example', HTTPS_FALLBACK), 'wss://relay.example/ws');
  assert.equal(resolveRelayUrl('relay.example:1234', HTTPS_FALLBACK), 'wss://relay.example:1234/ws');
});

test('resolveRelayUrl: an unparseable value never throws, and falls back to same-origin', () => {
  assert.doesNotThrow(() => resolveRelayUrl('::not a url::', HTTP_FALLBACK));
  assert.equal(resolveRelayUrl('::not a url::', HTTP_FALLBACK), 'ws://example.com/ws');
});

test('resolveRelayUrl: an unrelated scheme falls back to same-origin rather than being used verbatim', () => {
  assert.equal(resolveRelayUrl('ftp://relay.example', HTTP_FALLBACK), 'ws://example.com/ws');
});

test('resolveRelayUrl: a non-root path already present is left alone', () => {
  assert.equal(resolveRelayUrl('wss://relay.example/custom/path', HTTP_FALLBACK), 'wss://relay.example/custom/path');
});
