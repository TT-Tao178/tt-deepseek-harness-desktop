// v6.4.2-5：素材 HTTP 服务器冒烟测试（真实启动 + 请求 dshpet 素材）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { AssetServer } = require('../dist/pet/asset-server.js');

const builtin = [path.resolve('resources/pet/themes')];

test('AssetServer 启动并服务 dshpet 素材（HTTP 通道）', async () => {
  const srv = new AssetServer(() => builtin, () => '');
  await srv.start();
  try {
    assert.ok(srv.port > 0);
    const base = srv.urlFor('dshpet');
    assert.ok(base.startsWith('http://127.0.0.1:'));

    // 1) 正常素材：200 + video/webm
    const r1 = await fetch(base + encodeURIComponent('待机呼吸休闲') + '.webm');
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('content-type'), 'video/webm');
    const buf = Buffer.from(await r1.arrayBuffer());
    assert.ok(buf.length > 1000, 'webm 内容非空');

    // 2) 未知皮肤：404
    const r2 = await fetch(base + 'nope.webm');
    assert.equal(r2.status, 404);

    // 3) 路径穿越：400
    const r3 = await fetch('http://127.0.0.1:' + srv.port + '/assets/dshpet/..%2F..%2Fpackage.json');
    assert.equal(r3.status, 400);
  } finally {
    srv.stop();
  }
});
