const INPUT_LIMIT = 20 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let dialogSequence = 0;

/**
 * Return a 3:4 source rectangle. x/y select a fraction of the available travel,
 * so 0 and 1 always reach the corresponding image edges (even when zoomed).
 */
export function cropRect(width, height, zoom = 1, x = .5, y = .5) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('画像の幅と高さは正の有限数にしてください。');
  }
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 3) {
    throw new RangeError('拡大率は1〜3にしてください。');
  }
  if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError('位置は0〜1にしてください。');
  }
  const cropWidth = Math.min(width, height * .75) / zoom;
  const cropHeight = Math.min(height, cropWidth / .75);
  // Extremely small finite dimensions can underflow during zooming.
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new RangeError('切り抜き範囲を計算できない画像サイズです。');
  }
  return {
    x: (width - cropWidth) * x,
    y: (height - cropHeight) * y,
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * Edit a local JPEG/PNG/WebP Blob (File is also accepted).
 * Resolve to a metadata-free 900×1200 WebP File, or null on cancellation.
 * Invalid input, decoding failures and unavailable browser APIs reject.
 */
export async function editCastPhoto(file) {
  if (!(file instanceof Blob) || !IMAGE_TYPES.has(file.type)) {
    throw new TypeError('JPEG・PNG・WebPの画像を選んでください。');
  }
  if (file.size === 0 || file.size > INPUT_LIMIT) {
    throw new RangeError('元画像は空でない20MB以下の画像にしてください。');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new Error('画像を読み込めませんでした。別の画像を選んでください。', { cause });
  }

  let dialog;
  let frame = null;
  try {
    cropRect(bitmap.width, bitmap.height);
    const id = `cast-photo-${++dialogSequence}`;
    dialog = document.createElement('dialog');
    dialog.className = 'cast-photo-dialog';
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-description`);
    dialog.setAttribute('closedby', 'closerequest');
    dialog.innerHTML = `
      <div class="cast-photo-content">
      <h2 id="${id}-title">写真を調整</h2>
      <p id="${id}-description">写真を3:4の縦長に切り抜きます。</p>
      <div class="cast-photo-layout">
        <canvas class="cast-photo-canvas" width="360" height="480" role="img" aria-label="3対4の切り抜きプレビュー"></canvas>
        <div class="cast-photo-controls">
          <label class="field"><span>拡大率</span><input name="zoom" type="range" min="1" max="3" step="0.01" value="1" autofocus></label>
          <label class="field"><span>左右の位置</span><input name="x" type="range" min="0" max="1" step="0.01" value="0.5"></label>
          <label class="field"><span>上下の位置</span><input name="y" type="range" min="0" max="1" step="0.01" value="0.5"></label>
        </div>
      </div>
      <p class="notice error" role="alert" hidden></p>
      </div>
      <div class="cast-photo-footer">
        <button class="button secondary" type="button" data-action="cancel">キャンセル</button>
        <button class="button" type="button" data-action="save">この範囲で使う</button>
      </div>`;

    const preview = dialog.querySelector('canvas');
    const context = preview.getContext('2d');
    if (!context) throw new Error('この端末では画像を調整できません。');
    const sliders = [...dialog.querySelectorAll('input[type="range"]')];
    const [zoom, horizontal, vertical] = sliders;
    const cancel = dialog.querySelector('[data-action="cancel"]');
    const save = dialog.querySelector('[data-action="save"]');
    const notice = dialog.querySelector('.notice');
    const controls = [...sliders, cancel, save];
    let saving = false;
    let finished = false;

    const selection = () => cropRect(bitmap.width, bitmap.height,
      Number(zoom.value), Number(horizontal.value), Number(vertical.value));
    function draw(target, canvas) {
      const rect = selection();
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = 'high';
      target.clearRect(0, 0, canvas.width, canvas.height);
      target.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height,
        0, 0, canvas.width, canvas.height);
    }
    for (const slider of sliders) {
      slider.addEventListener('input', () => {
        if (saving || finished || frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!finished) draw(context, preview);
        });
      });
    }

    return await new Promise((resolve, reject) => {
      function complete(value) {
        if (finished) return;
        finished = true;
        resolve(value);
      }
      function setSaving(value) {
        saving = value;
        controls.forEach(control => { control.disabled = value; });
        dialog.setAttribute('aria-busy', String(value));
        dialog.setAttribute('closedby', value ? 'none' : 'closerequest');
      }
      dialog.addEventListener('cancel', event => {
        if (saving) event.preventDefault();
      });
      dialog.addEventListener('close', () => {
        if (finished) return;
        // close is not cancelable; restore the modal if closed programmatically
        // during encoding. The bitmap must remain alive until encoding finishes.
        if (saving) {
          try { dialog.showModal(); } catch (error) { reject(error); }
          return;
        }
        complete(null);
      });
      cancel.addEventListener('click', () => {
        if (!saving) complete(null);
      });
      save.addEventListener('click', async () => {
        if (saving || finished) return;
        setSaving(true);
        notice.hidden = true;
        try {
          const output = document.createElement('canvas');
          output.width = 900;
          output.height = 1200;
          const outputContext = output.getContext('2d');
          if (!outputContext) throw new Error('画像の書き出しを開始できませんでした。');
          // A fresh canvas carries only rendered pixels, not the input metadata.
          draw(outputContext, output);
          const blob = await new Promise((done, fail) => {
            output.toBlob(value => {
              if (value) done(value);
              else fail(new Error('画像の書き出しに失敗しました。'));
            }, 'image/webp', .92);
          });
          if (blob.type !== 'image/webp') {
            throw new Error('この端末ではWebP形式に書き出せませんでした。');
          }
          if (blob.size === 0 || blob.size > OUTPUT_LIMIT) {
            throw new Error('保存画像は4MB以下にしてください。範囲を調整して再度お試しください。');
          }
          complete(new File([blob], 'cast-photo.webp', { type: 'image/webp' }));
        } catch (error) {
          notice.textContent = `${error.message || '画像の書き出しに失敗しました。'} 調整してもう一度お試しいただけます。`;
          notice.hidden = false;
        } finally {
          if (!finished) setSaving(false);
        }
      });
      draw(context, preview);
      document.body.append(dialog);
      dialog.showModal();
    });
  } finally {
    if (frame !== null) cancelAnimationFrame(frame);
    try {
      if (dialog?.open) dialog.close();
    } finally {
      bitmap.close();
      dialog?.remove();
    }
  }
}
