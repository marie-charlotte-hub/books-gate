const cfg = window.BOOKS_GATE_CONFIG || {};
const configured =
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("COLLE_ICI") &&
  !cfg.SUPABASE_ANON_KEY.includes("COLLE_ICI");

let supabaseClient = null;

if (configured) {
  supabaseClient = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY
  );
}

function isNew(publishedAt) {
  if (!publishedAt) return false;
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
  return ageDays >= 0 && ageDays <= 7;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[ch]));
}

function showConfigNotice(target) {
  if (!configured) {
    target.innerHTML = `
      <div class="notice">
        Le site est prêt, mais <strong>config.js</strong> n'est pas encore configuré.
      </div>`;
    return true;
  }
  return false;
}

function storagePublicUrl(path) {
  if (!path) return "";
  const { data } = supabaseClient.storage.from("product-images").getPublicUrl(path);
  return data?.publicUrl || "";
}
