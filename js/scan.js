// 网页内扫码：打开后置摄像头，每隔一小段时间取一帧，用 jsQR 识别二维码。

let jsQRLoading = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQRLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/jsQR.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => { jsQRLoading = null; reject(new Error('扫码组件加载失败，请检查网络')); };
    document.head.append(s);
  });
  return jsQRLoading;
}

// 从二维码内容里取出编号：本站网址 ?a=290-0001，或者直接是 290-0001
export function assetFromScan(text) {
  try {
    const a = new URL(text).searchParams.get('a');
    if (a) return a;
  } catch { /* 不是网址 */ }
  return /^\s*\d{3}-?\d{3,4}\s*$/.test(text) ? text.trim() : null;
}

// 返回 stop()。onCode 对同一个二维码 2 秒内只触发一次。
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不支持网页调用摄像头，请用手机相机扫码');
  }
  const jsQR = await loadJsQR();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
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

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const recent = new Map();
  let stopped = false;
  let last = 0;

  const tick = (t) => {
    if (stopped) return;
    if (t - last > 150 && video.readyState >= 2) {
      last = t;
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code?.data) {
        const now = Date.now();
        if (!recent.has(code.data) || now - recent.get(code.data) > 2000) {
          recent.set(code.data, now);
          if (navigator.vibrate) navigator.vibrate(60);
          onCode(code.data);
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
}
