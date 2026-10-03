// 通用小工具：建 DOM（只用 textContent，不拼 HTML，防止数据里的内容被当成代码执行）、图片压缩、照片缓存。

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false || k === 'value') continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['checked', 'selected', 'disabled', 'multiple', 'hidden'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  // value 最后设：<select> 要等选项都加进去之后才能选中
  if (props && props.value !== undefined && props.value !== null) el.value = props.value;
  return el;
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 把照片缩到长边 maxSide 以内，转成 JPEG。用 <img> 解码，浏览器会按 EXIF 自动转正方向。
export async function compressImage(file, maxSide, quality) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`读不了这张图片：${file.name}（HEIC 格式请先转成 JPG）`));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// 照片文件名是随机的、写入后不再修改，所以可以永久缓存在浏览器里
const photoUrls = new Map();

export async function photoUrl(gh, path) {
  if (photoUrls.has(path)) return photoUrls.get(path);
  const key = `https://photo-cache.local/${gh.repo}/${path}`;
  let blob;
  try {
    const cache = await caches.open('photos-v1');
    const hit = await cache.match(key);
    if (hit) blob = await hit.blob();
    else {
      blob = await gh.readBlob(path);
      await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
    }
  } catch (e) {
    if (!blob) blob = await gh.readBlob(path); // 浏览器不支持 Cache Storage（比如非 https）时直接读
  }
  const url = URL.createObjectURL(blob);
  photoUrls.set(path, url);
  return url;
}

// <img> 先占位，照片异步加载
export function lazyPhoto(gh, path, props = {}) {
  const img = h('img', { alt: '', ...props, class: `${props.class || ''} loading` });
  if (path) {
    photoUrl(gh, path)
      .then((url) => { img.src = url; img.classList.remove('loading'); })
      .catch(() => img.classList.add('broken'));
  }
  return img;
}
