import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicControllerUrl } from '../server/controllerUrl';

test('Railway QR uses the public HTTPS domain without PUBLIC_URL', () => {
  assert.equal(publicControllerUrl('ABCD', { railwayPublicDomain: 'kart.up.railway.app' }),
    'https://kart.up.railway.app/controller.html?room=ABCD');
});

test('explicit public URL wins over Railway and request origins', () => {
  assert.equal(publicControllerUrl('ABCD', {
    publicUrl: 'https://kart.example.com/', railwayPublicDomain: 'kart.up.railway.app', requestOrigin: 'https://other.example.com',
  }), 'https://kart.example.com/controller.html?room=ABCD');
});

test('other HTTPS hosts use the game origin without proxy configuration', () => {
  assert.equal(publicControllerUrl('ABCD', { requestOrigin: 'https://kart.example.com:8443' }),
    'https://kart.example.com:8443/controller.html?room=ABCD');
});

test('local development and missing or malformed origins retain LAN discovery', () => {
  for (const requestOrigin of [undefined, 'null', 'garbage', 'http://localhost:5173', 'https://localhost:8788', 'https://127.0.0.1:8788', 'https://[::1]:8788', 'http://192.168.0.52:5173']) {
    assert.equal(publicControllerUrl('ABCD', { requestOrigin }), null);
  }
});

test('invalid configured schemes cannot generate non-web controller links', () => {
  assert.equal(publicControllerUrl('ABCD', { publicUrl: 'javascript:alert(1)', railwayPublicDomain: 'kart.up.railway.app' }),
    'https://kart.up.railway.app/controller.html?room=ABCD');
});
