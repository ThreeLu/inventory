// 网页内扫码：打开后置摄像头，每隔一小段时间取一帧，用 jsQR 识别二维码。
// 条形码（序列号）：浏览器自带 BarcodeDetector 就用它，没有（iPhone Safari）就用 ZXing（vendor/zxing.min.js，按需加载）。

const loading = {};

function loadScript(src, name) {
  if (window[name]) return Promise.resolve(window[name]);
  loading[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[name]);
    s.onerror = () => { delete loading[src]; reject(new Error('扫码组件加载失败，请检查网络')); };
    document.head.append(s);
  });
  return loading[src];
}
const loadJsQR = () => loadScript('vendor/jsQR.js', 'jsQR');

// 从二维码内容里取出编号：本站网址 ?a=290-0001，或者直接是 290-0001
export function assetFromScan(text) {
  try {
    const a = new URL(text).searchParams.get('a');
    if (a) return a;
  } catch { /* 不是网址 */ }
  return /^\s*\d{3}-?\d{3,4}\s*$/.test(text) ? text.trim() : null;
}

async function openCamera(video, width = 1280, height = 720) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不支持网页调用摄像头，请用手机相机扫码');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: width }, height: { ideal: height } }, audio: false,
    });
  } catch (e) {
    const denied = e.name === 'NotAllowedError' || e.name === 'SecurityError';
    throw new Error(denied
      ? '没有摄像头权限。iPhone：设置 → Safari → 相机 → 允许；安卓：在浏览器的网站设置里允许相机'
      : `打不开摄像头：${e.message}`);
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  return stream;
}

// 每隔 gap 毫秒取一帧交给 decode（返回识别出的文字或 null）；同一个内容 2 秒内只触发一次。返回 stop()。
function scanLoop(video, stream, decode, onCode, gap) {
  const recent = new Map();
  let stopped = false;
  let busy = false;
  let last = 0;
  const tick = async (t) => {
    if (stopped) return;
    if (!busy && t - last > gap && video.readyState >= 2) {
      last = t;
      busy = true;
      let text = null;
      try { text = await decode(); } catch { /* 这一帧没认出来 */ }
      busy = false;
      if (text && !stopped) {
        const now = Date.now();
        if (!recent.has(text) || now - recent.get(text) > 2000) {
          recent.set(text, now);
          if (navigator.vibrate) navigator.vibrate(60);
          onCode(text);
        }
      }
    }
    if (!stopped) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
}

// 返回 stop()。onCode 对同一个二维码 2 秒内只触发一次。
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不支持网页调用摄像头，请用手机相机扫码');
  }
  const jsQR = await loadJsQR();
  const stream = await openCamera(video);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return scanLoop(video, stream, () => {
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
  }, onCode, 150);
}

// 序列号条上常见的格式：一维码（Code 128 最常见）+ 二维码 + DataMatrix
const NATIVE_FORMATS = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'qr_code', 'data_matrix'];
const ZXING_FORMATS = ['CODE_128', 'CODE_39', 'CODE_93', 'CODABAR', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'QR_CODE', 'DATA_MATRIX'];

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    return formats.includes('code_128') ? new window.BarcodeDetector({ formats }) : null;
  } catch { return null; }
}

// 扫条形码：只认取景框附近那一条横带（标签上常常并排好几条码，对准哪条认哪条）。返回 stop()。
export async function startBarcodeScanner(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不支持网页调用摄像头');
  }
  const native = await nativeDetector();
  const ZXing = native ? null : await loadScript('vendor/zxing.min.js', 'ZXing');
  let reader = null;
  if (ZXing) {
    reader = new ZXing.MultiFormatReader();
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS.map((f) => ZXing.BarcodeFormat[f]));
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
  }
  const stream = await openCamera(video, 1920, 1080);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return scanLoop(video, stream, async () => {
    // 页面上的画面框是 16:9、object-fit: cover（手机竖着拿时视频是竖的，会裁掉上下）：
    // 先算出看得见的那块，再取它中间 80% 宽、40% 高的横带，和取景框一致
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const A = 16 / 9;
    const visW = vw / vh > A ? vh * A : vw;
    const visH = vw / vh > A ? vh : vw / A;
    const sw = visW * 0.8;
    const sh = visH * 0.4;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;
    const scale = Math.min(1, 1280 / sw);
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (native) return (await native.detect(canvas))[0]?.rawValue || null;
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)));
    try {
      return reader.decodeWithState(bitmap).getText();
    } finally {
      reader.reset();
    }
  }, onCode, 200);
}

// 扫到的内容去掉「S/N:」「SN」「Serial No.」这类前缀和空白
export function serialFromScan(text) {
  return String(text).trim().replace(/^(s\/n|sn(?=[\s:：#])|serial\s*(no\.?|number)?(?=[\s:：#.]))\s*[:：#.]?\s*/i, '').trim();
}
