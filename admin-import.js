let parsedBook = null;
let previewObjectUrls = [];

const loginWrap = document.getElementById("loginWrap");
const adminShell = document.getElementById("adminShell");
const loginMessage = document.getElementById("loginMessage");

function localElements(node, name) {
  return Array.from(node.getElementsByTagNameNS("*", name));
}
function firstLocal(node, name) {
  return localElements(node, name)[0] || null;
}
function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}
function normalizePath(baseFile, target) {
  const parts = baseFile.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}
function cellColumn(ref) {
  return (ref.match(/[A-Z]+/i) || [""])[0].toUpperCase();
}
async function getSharedStrings(zip) {
  const f = zip.file("xl/sharedStrings.xml");
  if (!f) return [];
  const doc = parseXml(await f.async("string"));
  return localElements(doc, "si").map(si => localElements(si, "t").map(t => t.textContent || "").join(""));
}
function readCell(cell, shared) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    const t = firstLocal(cell, "t");
    return t ? t.textContent || "" : "";
  }
  const v = firstLocal(cell, "v");
  if (!v) return "";
  const raw = v.textContent || "";
  if (type === "s") return shared[Number(raw)] ?? "";
  return raw;
}
async function detectDrawingFile(zip) {
  const relFile = zip.file("xl/worksheets/_rels/sheet1.xml.rels");
  if (!relFile) return null;
  const doc = parseXml(await relFile.async("string"));
  const rel = localElements(doc, "Relationship").find(r => (r.getAttribute("Type") || "").endsWith("/drawing"));
  return rel ? normalizePath("xl/worksheets/sheet1.xml", rel.getAttribute("Target")) : null;
}
async function extractProductImages(zip) {
  const result = new Map();
  const drawingFile = await detectDrawingFile(zip);
  if (!drawingFile || !zip.file(drawingFile)) return result;

  const relFile = drawingFile.replace(/\/([^/]+)$/, "/_rels/$1.rels");
  if (!zip.file(relFile)) return result;

  const [drawingText, relText] = await Promise.all([zip.file(drawingFile).async("string"), zip.file(relFile).async("string")]);
  const drawingDoc = parseXml(drawingText);
  const relDoc = parseXml(relText);
  const rels = new Map(localElements(relDoc, "Relationship").map(r => [r.getAttribute("Id"), r.getAttribute("Target")]));

  for (const anchor of Array.from(drawingDoc.documentElement.children)) {
    const from = firstLocal(anchor, "from");
    const blip = firstLocal(anchor, "blip");
    if (!from || !blip) continue;
    const col = Number(firstLocal(from, "col")?.textContent || -1);
    const row = Number(firstLocal(from, "row")?.textContent || -1) + 1;

    // Colonne A uniquement = visuel produit. La colonne F contient les codes-barres.
    if (col !== 0) continue;

    const rid = blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed")
      || blip.getAttribute("r:embed");
    const target = rels.get(rid);
    if (!target) continue;
    const mediaPath = normalizePath(drawingFile, target);
    const media = zip.file(mediaPath);
    if (!media) continue;
    const ext = mediaPath.split(".").pop().toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const blob = new Blob([await media.async("arraybuffer")], { type: mime });
    result.set(row, blob);
  }
  return result;
}
function parseHeaderTitle(header) {
  const h = String(header || "").trim();
  const year = h.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear().toString();
  const typo = h.match(/TYPO\s*(63|70)/i)?.[1];
  let title = h.replace(/^BOOK\s+/i, "").replace(/\s+20\d{2}\b.*$/i, "").trim();
  return { title, year: Number(year), group: typo ? `TMB ${typo}` : null };
}
async function parseBookXlsx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  if (!zip.file("xl/worksheets/sheet1.xml")) throw new Error("La première feuille Excel est introuvable.");

  const shared = await getSharedStrings(zip);
  const sheetDoc = parseXml(await zip.file("xl/worksheets/sheet1.xml").async("string"));
  const rows = new Map();

  for (const row of localElements(sheetDoc, "row")) {
    const rowNum = Number(row.getAttribute("r"));
    const values = {};
    for (const cell of localElements(row, "c")) {
      values[cellColumn(cell.getAttribute("r") || "")] = readCell(cell, shared).trim();
    }
    rows.set(rowNum, values);
  }

  const header2 = rows.get(2) || {};
  if ((header2.B || "").toUpperCase() !== "LIBELLÉ" || (header2.C || "").toUpperCase() !== "EAN") {
    throw new Error("Le format du fichier n'est pas reconnu. Je cherche les colonnes LIBELLÉ et EAN sur la ligne 2.");
  }

  const images = await extractProductImages(zip);
  let currentFamily = "";
  const products = [];
  const families = [];
  const seenFamily = new Set();

  const sortedRows = [...rows.keys()].sort((a,b)=>a-b);
  for (const rowNum of sortedRows) {
    if (rowNum <= 2) continue;
    const r = rows.get(rowNum) || {};
    const isFamily = r.A && !r.B && !r.C;
    if (isFamily) {
      currentFamily = r.A.replace(/\s+/g, " ").trim();
      if (currentFamily && !seenFamily.has(currentFamily)) {
        seenFamily.add(currentFamily);
        families.push(currentFamily);
      }
      continue;
    }
    if (!r.C || !r.B) continue;

    products.push({
      rowNum,
      label: r.B,
      ean: String(r.C).trim(),
      rank: (r.D || "").trim(),
      ifls: String(r.E || "").trim(),
      assortment: ["TAN","TAC"].includes((r.G || "").toUpperCase()) ? (r.G || "").toUpperCase() : null,
      family: currentFamily || "Sans famille",
      imageBlob: images.get(rowNum) || null
    });
  }

  if (!products.length) throw new Error("Aucune référence produit n'a été détectée.");

  const headerInfo = parseHeaderTitle(rows.get(1)?.A || "");
  const rankCounts = {};
  const assortmentCounts = { TAN:0, TAC:0 };
  products.forEach(p => {
    rankCounts[p.rank || "—"] = (rankCounts[p.rank || "—"] || 0) + 1;
    if (p.assortment) assortmentCounts[p.assortment]++;
  });

  return {
    fileName: file.name,
    title: headerInfo.title,
    year: headerInfo.year,
    group: headerInfo.group,
    products,
    families,
    rankCounts,
    assortmentCounts,
    imageCount: products.filter(p=>p.imageBlob).length
  };
}
function revokePreviewUrls() {
  previewObjectUrls.forEach(URL.revokeObjectURL);
  previewObjectUrls = [];
}
function renderPreview(book) {
  revokePreviewUrls();
  const ranks = Object.entries(book.rankCounts).sort().map(([k,v])=>`${escapeHtml(k)} : ${v}`).join(" • ");
  document.getElementById("previewKpis").innerHTML = `
    <div class="kpi"><strong>${book.products.length}</strong><span>références</span></div>
    <div class="kpi"><strong>${book.families.length}</strong><span>familles</span></div>
    <div class="kpi"><strong>${book.assortmentCounts.TAN}</strong><span>TAN</span></div>
    <div class="kpi"><strong>${book.assortmentCounts.TAC}</strong><span>TAC</span></div>
    <div class="kpi"><strong>${book.imageCount}</strong><span>photos détectées</span></div>`;
  document.getElementById("familyChips").innerHTML = book.families.map(f=>`<span class="chip">${escapeHtml(f)}</span>`).join("");
  document.getElementById("analysisMessage").innerHTML = `
    <div class="success"><strong>Fichier reconnu ✓</strong> — ${ranks}</div>
    ${book.imageCount < book.products.length ? `<div class="notice warning">${book.products.length-book.imageCount} référence(s) n'ont pas de photo produit intégrée dans l'Excel. Elles auront un emplacement image vide, ce qui n'empêche pas la publication.</div>` : ""}`;

  document.getElementById("previewRows").innerHTML = book.products.slice(0,12).map(p=>{
    let thumb = '<span class="meta">—</span>';
    if (p.imageBlob) {
      const url = URL.createObjectURL(p.imageBlob);
      previewObjectUrls.push(url);
      thumb = `<img class="preview-thumb" src="${url}" alt="">`;
    }
    return `<tr><td>${thumb}</td><td>${escapeHtml(p.label)}</td><td>${escapeHtml(p.ean)}</td><td>${escapeHtml(p.rank)}</td><td>${escapeHtml(p.ifls)}</td><td>${escapeHtml(p.assortment||"")}</td><td>${escapeHtml(p.family)}</td></tr>`;
  }).join("");
  document.getElementById("preview").style.display = "";
}
function setProgress(percent, text) {
  document.getElementById("progressWrap").style.display = "";
  document.getElementById("progressBar").style.width = `${Math.max(0,Math.min(100,percent))}%`;
  document.getElementById("progressText").textContent = text;
}
async function compressToWebp(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url});
    const max = 700;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth*scale));
    const h = Math.max(1, Math.round(img.naturalHeight*scale));
    const canvas = document.createElement("canvas");
    canvas.width=w; canvas.height=h;
    const ctx=canvas.getContext("2d");
    ctx.fillStyle="#fff"; ctx.fillRect(0,0,w,h);
    ctx.drawImage(img,0,0,w,h);
    return await new Promise(resolve=>canvas.toBlob(resolve,"image/webp",0.76));
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function mapExistingProducts(eans) {
  const map = new Map();
  for (let i=0;i<eans.length;i+=80) {
    const chunk=eans.slice(i,i+80);
    const {data,error}=await supabaseClient.from("products").select("id,ean,image_path").in("ean",chunk);
    if(error) throw error;
    (data||[]).forEach(p=>map.set(p.ean,p));
  }
  return map;
}
async function parallelLimit(items, limit, worker) {
  let next = 0;
  const runners = Array.from({length:Math.min(limit,items.length)}, async()=>{
    while(next<items.length){
      const i=next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}
async function publishParsedBook() {
  if (!parsedBook) return;
  const publishBtn=document.getElementById("publishBtn");
  publishBtn.disabled=true;

  let createdBookId=null;
  try {
    const title=document.getElementById("bookTitle").value.trim();
    const storeGroup=document.getElementById("storeGroup").value;
    const year=Number(document.getElementById("bookYear").value);
    if(!title) throw new Error("Indique un nom pour le book.");
    if(!year) throw new Error("Indique une année.");

    setProgress(3,"Création du book…");
    const {data:book,error:bookError}=await supabaseClient.from("books").insert({
      store_group:storeGroup,title,year,is_published:false
    }).select("id").single();
    if(bookError) throw bookError;
    createdBookId=book.id;

    setProgress(8,"Création des familles…");
    const familyRows=parsedBook.families.map((name,i)=>({book_id:book.id,name,sort_order:i+1}));
    const {data:familyData,error:familyError}=await supabaseClient.from("families").insert(familyRows).select("id,name");
    if(familyError) throw familyError;
    const familyMap=new Map((familyData||[]).map(f=>[f.name,f.id]));

    const eans=parsedBook.products.map(p=>p.ean);
    const existing=await mapExistingProducts(eans);

    setProgress(15,"Optimisation et envoi des photos…");
    let doneImages=0;
    await parallelLimit(parsedBook.products.filter(p=>p.imageBlob), 5, async p=>{
      const webp=await compressToWebp(p.imageBlob);
      if(!webp) throw new Error(`Impossible de préparer la photo ${p.ean}.`);
      const path=`products/${p.ean}.webp`;
      const {error}=await supabaseClient.storage.from("product-images").upload(path,webp,{contentType:"image/webp",upsert:true,cacheControl:"3600"});
      if(error) throw error;
      p.uploadedImagePath=path;
      doneImages++;
      const pct=15+Math.round((doneImages/Math.max(1,parsedBook.imageCount))*48);
      setProgress(pct,`Photos : ${doneImages}/${parsedBook.imageCount}`);
    });

    setProgress(65,"Enregistrement des produits…");
    const productRows=parsedBook.products.map(p=>({
      ean:p.ean,
      label:p.label,
      ifls:p.ifls || null,
      image_path:p.uploadedImagePath || existing.get(p.ean)?.image_path || null
    }));
    const {data:productData,error:productError}=await supabaseClient.from("products").upsert(productRows,{onConflict:"ean"}).select("id,ean");
    if(productError) throw productError;
    const productMap=new Map((productData||[]).map(p=>[p.ean,p.id]));

    setProgress(76,"Composition du book…");
    const linkRows=parsedBook.products.map((p,i)=>({
      book_id:book.id,
      product_id:productMap.get(p.ean),
      family_id:familyMap.get(p.family) || null,
      rank:p.rank || null,
      assortment_code:p.assortment || null,
      sort_order:i+1
    }));
    const {error:linkError}=await supabaseClient.from("book_products").insert(linkRows);
    if(linkError) throw linkError;

    setProgress(92,"Publication…");
    const {error:publishError}=await supabaseClient.from("books").update({
      is_published:true,
      published_at:new Date().toISOString()
    }).eq("id",book.id);
    if(publishError) throw publishError;

    setProgress(100,"Book publié !");
    document.getElementById("analysisMessage").innerHTML='<div class="success"><strong>Book publié avec succès ✓</strong> Il est maintenant visible par les magasins.</div>';
    await loadAdminBooks();
    setTimeout(()=>{location.href=`book.html?id=${book.id}`},900);
  } catch(err) {
    console.error(err);
    document.getElementById("analysisMessage").innerHTML=`<div class="error"><strong>Publication impossible :</strong> ${escapeHtml(err.message||String(err))}</div>`;
    if(createdBookId) {
      await supabaseClient.from("books").delete().eq("id",createdBookId);
    }
    publishBtn.disabled=false;
  }
}
async function deleteBook(bookId,title) {
  if(!confirm(`Supprimer définitivement "${title}" ?\n\nLe book disparaîtra du site. Les produits et photos qui ne sont utilisés dans aucun autre book seront également supprimés.`)) return;
  try {
    const {data:links,error:linksError}=await supabaseClient.from("book_products").select("product_id").eq("book_id",bookId);
    if(linksError) throw linksError;
    const productIds=[...new Set((links||[]).map(x=>x.product_id).filter(Boolean))];

    const {error:deleteError}=await supabaseClient.from("books").delete().eq("id",bookId);
    if(deleteError) throw deleteError;

    if(productIds.length) {
      const {data:remaining,error:remainingError}=await supabaseClient.from("book_products").select("product_id").in("product_id",productIds);
      if(remainingError) throw remainingError;
      const used=new Set((remaining||[]).map(x=>x.product_id));
      const orphanIds=productIds.filter(id=>!used.has(id));

      if(orphanIds.length) {
        const {data:orphans,error:orphansError}=await supabaseClient.from("products").select("id,image_path").in("id",orphanIds);
        if(orphansError) throw orphansError;
        const paths=(orphans||[]).map(p=>p.image_path).filter(Boolean);
        if(paths.length) {
          const {error:storageError}=await supabaseClient.storage.from("product-images").remove(paths);
          if(storageError) console.warn("Photos non supprimées :",storageError);
        }
        const {error:prodDeleteError}=await supabaseClient.from("products").delete().in("id",orphanIds);
        if(prodDeleteError) throw prodDeleteError;
      }
    }
    await loadAdminBooks();
  } catch(err) {
    alert("Impossible de supprimer ce book : "+(err.message||err));
  }
}
async function loadAdminBooks() {
  const box=document.getElementById("adminBooks");
  const {data,error}=await supabaseClient.from("books").select("id,title,store_group,year,is_published,published_at,created_at").order("created_at",{ascending:false});
  if(error){box.innerHTML='<div class="empty">Impossible de charger les books.</div>';return}
  if(!data.length){box.innerHTML='<div class="empty">Aucun book pour le moment.</div>';return}
  box.innerHTML=data.map(b=>`
    <div class="admin-book-row">
      <div><strong>${escapeHtml(b.title)}</strong><div class="meta">${escapeHtml(b.store_group)} • ${b.year} • ${b.is_published?"Publié":"Brouillon"}${b.published_at?` • ${new Date(b.published_at).toLocaleDateString("fr-FR")}`:""}</div></div>
      <div class="row">${b.is_published?`<a class="btn btn-secondary" href="book.html?id=${b.id}">Voir</a>`:""}<button class="btn btn-danger" data-delete="${b.id}" data-title="${escapeHtml(b.title)}">Supprimer</button></div>
    </div>`).join("");
  box.querySelectorAll("[data-delete]").forEach(btn=>btn.addEventListener("click",()=>deleteBook(btn.dataset.delete,btn.dataset.title)));
}
async function refreshAuth() {
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(!session){loginWrap.style.display="";adminShell.style.display="none";return}
  const {data:adminRows}=await supabaseClient.from("admin_users").select("user_id").eq("user_id",session.user.id);
  if(adminRows?.length){loginWrap.style.display="none";adminShell.style.display="";await loadAdminBooks()}
  else{await supabaseClient.auth.signOut();loginMessage.innerHTML='<div class="error">Ce compte n’est pas administrateur.</div>'}
}

document.getElementById("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();loginMessage.innerHTML="";
  const {error}=await supabaseClient.auth.signInWithPassword({email:document.getElementById("email").value.trim(),password:document.getElementById("password").value});
  if(error){loginMessage.innerHTML=`<div class="error">${escapeHtml(error.message)}</div>`;return}
  await refreshAuth();
});
document.getElementById("logoutBtn").addEventListener("click",async()=>{await supabaseClient.auth.signOut();await refreshAuth()});

document.getElementById("analyzeBtn").addEventListener("click",async()=>{
  const file=document.getElementById("excelFile").files[0];
  if(!file){document.getElementById("analysisMessage").innerHTML='<div class="error">Choisis d’abord un fichier Excel.</div>';return}
  const btn=document.getElementById("analyzeBtn");btn.disabled=true;btn.textContent="Analyse…";
  try{
    parsedBook=await parseBookXlsx(file);
    if(parsedBook.title) document.getElementById("bookTitle").value=parsedBook.title;
    if(parsedBook.year) document.getElementById("bookYear").value=parsedBook.year;
    if(parsedBook.group) document.getElementById("storeGroup").value=parsedBook.group;
    renderPreview(parsedBook);
  }catch(err){
    parsedBook=null;
    document.getElementById("preview").style.display="none";
    document.getElementById("analysisMessage").innerHTML=`<div class="error"><strong>Analyse impossible :</strong> ${escapeHtml(err.message||String(err))}</div>`;
  }finally{btn.disabled=false;btn.textContent="Analyser le fichier"}
});
document.getElementById("publishBtn").addEventListener("click",publishParsedBook);

if(!showConfigNotice(document.getElementById("configNotice"))) refreshAuth();
