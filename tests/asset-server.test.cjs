// v6.4.2-5：素材 HTTP 服务器冒烟测试（真实启动 + 请求 dshpet 素材；用 node:http，不依赖全局 fetch）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { AssetServer } = require('../dist/pet/asset-server.js');

const builtin = [path.resolve('resources/pet/themes')];

function req(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('AssetServer 启动并服务 dshpet 素材（HTTP 通道）', async () => {
  const srv = new AssetServer(() => builtin, () => '');
  await srv.start();
  try {
    assert.ok(srv.port > 0);
    const base = srv.urlFor('dshpet');
    assert.ok(base.startsWith('http://127.0.0.1:'));

    // 1) 正常素材：200 + video/webm
    const r1 = await req(base + encodeURIComponent('待机呼吸休闲') + '.webm');
    assert.equal(r1.status, 200);
    assert.equal(r1.type, 'video/webm');
    assert.ok(r1.body.length > 1000, 'webm 内容非空');

    // 2) 未知皮肤：404
    const r2 = await req(base + 'nope.webm');
    assert.equal(r2.status, 404);

    // 3) 路径穿越：400
    const r3 = await req('http://127.0.0.1:' + srv.port + '/assets/dshpet/..%2F..%2Fpackage.json');
    assert.equal(r3.status, 400);
  } finally {
    srv.stop();
  }
});
