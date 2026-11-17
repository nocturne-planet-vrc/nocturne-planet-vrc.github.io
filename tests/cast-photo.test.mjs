import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect, editCastPhoto } from '../public/cast-photo.mjs';

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
    `expected ${actual} to be approximately ${expected}`);
}

test('NodeでDOMなしに公開APIをimportできる', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof cropRect, 'function');
  assert.equal(typeof editCastPhoto, 'function');
});

test('9:16の投稿画像は中央の3:4を切り抜き、上下を除く', () => {
  assert.deepEqual(cropRect(900, 1600), { x: 0, y: 200, width: 900, height: 1200 });
});

test('横長画像は中央の3:4を切り抜き、左右を除く', () => {
  assert.deepEqual(cropRect(1600, 900), { x: 462.5, y: 0, width: 675, height: 900 });
});

test('3:4画像は拡大率1で画像全体を使う', () => {
  assert.deepEqual(cropRect(900, 1200), { x: 0, y: 0, width: 900, height: 1200 });
  assert.deepEqual(cropRect(900, 1200, 1, 0, 1), cropRect(900, 1200));
});

test('ズームは同じ中心で切り抜き寸法を縮め、最大3倍を含む', () => {
  assert.deepEqual(cropRect(900, 1600, 2), { x: 225, y: 500, width: 450, height: 600 });
  assert.deepEqual(cropRect(900, 1200, 3), { x: 300, y: 400, width: 300, height: 400 });
});

test('位置の端点は元画像の四隅まで届く', () => {
  for (const [width, height] of [[900, 1600], [1600, 900], [900, 1200]]) {
    for (const zoom of [1, 2, 3]) {
      for (const x of [0, 1]) for (const y of [0, 1]) {
        const rect = cropRect(width, height, zoom, x, y);
        near(rect.x, x === 0 ? 0 : width - rect.width);
        near(rect.y, y === 0 ? 0 : height - rect.height);
      }
    }
  }
});

test('位置は移動可能な距離に対する割合で、縦横が独立する', () => {
  const rect = cropRect(1600, 900, 2, .25, .75);
  assert.deepEqual(rect, { x: 315.625, y: 337.5, width: 337.5, height: 450 });
});

test('小さい画像や小数寸法も切り抜き可能で、出力用にupscaleできる', () => {
  assert.deepEqual(cropRect(3, 4), { x: 0, y: 0, width: 3, height: 4 });
  const rect = cropRect(.3, .4, 2);
  near(rect.width, .15);
  near(rect.height, .2);
  near(rect.x, .075);
  near(rect.y, .1);
});

test('様々な比率・ズーム・位置でも3:4の正の矩形が元画像内に収まる', () => {
  for (const [width, height] of [[1, 10000], [10000, 1], [4032, 3024], [601, 997], [900, 1200], [.125, .7]]) {
    for (const zoom of [1, 1.01, 1.7, 2.99, 3]) {
      for (const x of [0, .13, .5, 1]) for (const y of [0, .71, 1]) {
        const rect = cropRect(width, height, zoom, x, y);
        assert.ok(Object.values(rect).every(Number.isFinite));
        assert.ok(rect.width > 0 && rect.height > 0);
        near(rect.width / rect.height, 3 / 4);
        assert.ok(rect.x >= 0 && rect.y >= 0);
        assert.ok(rect.x + rect.width <= width + width * 1e-12);
        assert.ok(rect.y + rect.height <= height + height * 1e-12);
        near(rect.width, Math.min(width, height * .75) / zoom);
      }
    }
  }
});

test('0・負数・非finite・数値以外の寸法を拒否する', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, '900', null, undefined, {}, true]) {
    assert.throws(() => cropRect(value, 1200), RangeError);
    assert.throws(() => cropRect(900, value), RangeError);
  }
});

test('範囲外・非finite・数値以外のズームを拒否する', () => {
  for (const value of [0, -1, .999, 3.001, NaN, Infinity, -Infinity, '2', null, {}, true]) {
    assert.throws(() => cropRect(900, 1200, value), RangeError);
  }
});

test('範囲外・非finite・数値以外の左右上下位置を拒否する', () => {
  for (const value of [-.001, 1.001, NaN, Infinity, -Infinity, '.5', null, {}, true]) {
    assert.throws(() => cropRect(900, 1200, 1, value, .5), RangeError);
    assert.throws(() => cropRect(900, 1200, 1, .5, value), RangeError);
  }
});

test('不正な入力ファイルはDOMや画像デコードに触れずに拒否する', async () => {
  for (const file of [null, {}, { type: 'image/jpeg', size: 1 }, new Blob(['gif'], { type: 'image/gif' })]) {
    await assert.rejects(editCastPhoto(file), TypeError);
  }
  await assert.rejects(editCastPhoto(new Blob([], { type: 'image/png' })), RangeError);
  const tooLarge = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/jpeg' });
  await assert.rejects(editCastPhoto(tooLarge), RangeError);
});
