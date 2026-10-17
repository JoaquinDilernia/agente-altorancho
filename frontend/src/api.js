// Cliente de la API del backend. Inyectable para tests (fetchFn, getToken).
export function createApi({ baseUrl, getToken, fetchFn = fetch, onAuthError = () => {} }) {
  async function req(path, { method = 'GET', body, form } = {}) {
    const token = await getToken();
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (form) {
      payload = form; // FormData: el browser pone el content-type con boundary
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetchFn(`${baseUrl}${path}`, { method, headers, ...(payload ? { body: payload } : {}) });
    if (res.status === 401) {
      onAuthError();
      throw new Error('Sesión expirada');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Error ${res.status}`);
    }
    return res.json();
  }
  // Sube un archivo crudo (PUT) informando el avance: fetch no lo informa, XHR sí. onProgress recibe 0..1
  async function upload(path, file, onProgress) {
    const token = await getToken();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${baseUrl}${path}`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || ''));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* sin cuerpo */ }
        if (xhr.status === 401) {
          onAuthError();
          reject(new Error('Sesión expirada'));
        } else if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `Error ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Se cortó la subida. Revisá internet y probá de nuevo.'));
      xhr.send(file);
    });
  }

  return {
    get: (path) => req(path),
    post: (path, body) => req(path, { method: 'POST', body }),
    postForm: (path, form) => req(path, { method: 'POST', form }),
    put: (path, body) => req(path, { method: 'PUT', body }),
    patch: (path, body) => req(path, { method: 'PATCH', body }),
    del: (path) => req(path, { method: 'DELETE' }),
    upload,
  };
}
