// =====================================================================
// 🔥 FIREBASE
// =====================================================================
const firebaseConfig = {
  apiKey: "AIzaSyA2zmpdXLDvwC6pjjTEz17pum6q9YWaSp4",
  authDomain: "gestao-territorio.firebaseapp.com",
  projectId: "gestao-territorio",
  storageBucket: "gestao-territorio.firebasestorage.app",
  messagingSenderId: "412026583803",
  appId: "1:412026583803:web:9cd3890ccd86126f2ace5e"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// =====================================================================
// 🏘️ CONGREGAÇÕES
// =====================================================================
const CONGREGACOES = {
  jardins:   { nome: 'Jardins',    cor: '#2e7d32', prefixo: 'jrdTer' },
  belavista: { nome: 'Bela Vista', cor: '#6a1b9a', prefixo: 'bvTer'  },
  central:   { nome: 'Central',    cor: '#c62828', prefixo: 'ctlTer' }
};

function nomeCongregacao(c) { return CONGREGACOES[c]?.nome || c; }

function congregacaoPorPrefixo(cod) {
  if (!cod) return 'jardins';
  if (cod.startsWith('jrdTer')) return 'jardins';
  if (cod.startsWith('bvTer'))  return 'belavista';
  if (cod.startsWith('ctlTer') || cod.startsWith('ctTer')) return 'central';
  return 'jardins';
}

function proximoCodigo(c) {
  const p = CONGREGACOES[c].prefixo;
  const ex = dadosTerritorios.filter(t => t.codigo.startsWith(p))
    .map(t => parseInt(t.codigo.replace(/\D/g, ''), 10) || 0);
  return `${p}${String((ex.length ? Math.max(...ex) : 0) + 1).padStart(3, '0')}`;
}

// =====================================================================
// 🗺️ MAPA
// =====================================================================
const map = L.map('map').setView([-4.236661, -56.006867], 14);
L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20 }).addTo(map);

let geojsonLayer, geojsonData, territorioAtivo, camadaDestacada;
let modoMarcacaoAtivo = false, modoDesenhoAtivo = false, modoEdicaoAtivo = false;
let camadaMarcadores = L.layerGroup().addTo(map);
let camadaCoordenadas = L.layerGroup().addTo(map);
let coordenadasGPS, marcadorGPS, marcadorCoordenadaAtiva;
let editorPoligono, pontosDesenho = [], poligonoSendoEditado;
let unsubscribeTerritorios, usuarioAtual;
let dadosTerritorios = [];

// =====================================================================
// 🔐 AUTENTICAÇÃO
// =====================================================================
async function autenticar() {
  try {
    const c = await auth.signInAnonymously();
    usuarioAtual = c.user.uid;
    console.log('[Auth] UID:', usuarioAtual);
  } catch (e) {
    console.error('[Auth] Falha:', e);
    usuarioAtual = 'anon-' + Math.random().toString(36).slice(2, 8);
  }
}

// =====================================================================
// 🔄 SINCRONIZAÇÃO EM TEMPO REAL
// =====================================================================
function escutarTerritorios() {
  if (unsubscribeTerritorios) unsubscribeTerritorios();
  unsubscribeTerritorios = db.collection('territorios').onSnapshot(snap => {
    const arr = [];
    snap.forEach(doc => {
      const d = doc.data();
      let geom = d.geometry;
      if (typeof geom === 'string') {
        try { geom = JSON.parse(geom); } catch (e) { geom = null; }
      }
      arr.push({
        codigo: doc.id,
        congregacao: d.congregacao || congregacaoPorPrefixo(doc.id),
        status: d.status || 'Livre',
        publicador: d.publicador || '',
        dataSaida: d.dataSaida || '',
        dataConclusao: d.dataConclusao || '',
        coordenada: d.coordenada || null,
        pontos: d.pontos || [],
        ultimaAlteracao: d.ultimaAlteracao || null,
        _geometry: geom
      });
    });

    if (arr.length === 0) { semearFirestore(); return; }

    dadosTerritorios = arr;
    salvarCacheLocal();

    geojsonData = {
      type: 'FeatureCollection',
      features: arr.filter(t => t._geometry).map(t => ({
        type: 'Feature',
        geometry: t._geometry,
        properties: { name: t.codigo }
      }))
    };

    renderizarMapa(false);

    if (territorioAtivo) {
      const at = dadosTerritorios.find(t => t.codigo === territorioAtivo.info.codigo);
      if (at) {
        territorioAtivo.info = at;
        atualizarBottomSheet(at);
        atualizarFichaCompleta(at);
        atualizarListaPontosDOM();
      }
    }

    console.log(`[Sync] ${arr.length} territórios.`);
  }, err => console.error('[Sync] Erro:', err));
}

// =====================================================================
// 🌱 SEMEAR FIRESTORE (1ª execução)
// =====================================================================
async function semearFirestore() {
  try {
    const r = await fetch('territorios.geojson');
    if (!r.ok) throw new Error('geojson não encontrado (HTTP ' + r.status + ')');
    const g = await r.json();
    if (!g.features?.length) throw new Error('geojson sem features');

    const b = db.batch();
    g.features.forEach(f => {
      const cod = f.properties.name;
      const ref = db.collection('territorios').doc(cod);

      b.set(ref, {
        congregacao: congregacaoPorPrefixo(cod),
        status: 'Livre',
        publicador: '',
        dataSaida: '',
        dataConclusao: '',
        coordenada: null,
        pontos: [],
        geometry: JSON.stringify(f.geometry),
        ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
        ultimoUsuario: usuarioAtual
      });

      b.set(ref.collection('historico').doc(), {
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'Livre',
        publicador: '',
        dataSaida: '',
        dataConclusao: '',
        operacao: 'criacao',
        usuario: usuarioAtual
      });
    });

    await b.commit();
    console.log(`[Seed] Firestore semeado com ${g.features.length} territórios.`);
  } catch (err) {
    console.error('[Seed] Erro:', err);
    alert('Erro ao semear: ' + err.message + '\n\nVerifique se territorios.geojson está na raiz.');
  }
}

// =====================================================================
// 💾 CACHE LOCAL
// =====================================================================
function salvarCacheLocal() {
  localStorage.setItem('hourglass_db', JSON.stringify(
    dadosTerritorios.map(({ _geometry, ...r }) => r)
  ));
}

// =====================================================================
// 🎨 ESTILOS
// =====================================================================
function obterEstilo(cod) {
  const it = dadosTerritorios.find(t => t.codigo === cod);
  const s = it?.status || 'Livre';
  switch (s) {
    case 'Designado':   return { color: '#f57c00', weight: 3, fillColor: '#f57c00', fillOpacity: 0.55 };
    case 'Trabalhando': return { color: '#fbc02d', weight: 3, fillColor: '#fbc02d', fillOpacity: 0.60 };
    case 'Concluído':   return { color: '#1976d2', weight: 3, fillColor: '#1976d2', fillOpacity: 0.55 };
    default:            return { color: '#2e7d32', weight: 3, fillColor: '#2e7d32', fillOpacity: 0.45 };
  }
}

// =====================================================================
// 🗺️ RENDERIZAR
// =====================================================================
function renderizarMapa(autoZoom = true) {
  if (!geojsonData) return;
  if (geojsonLayer) map.removeLayer(geojsonLayer);

  const cSel = document.getElementById('filtro-congregacao').value;
  const sSel = document.getElementById('filtro-status').value;
  const codAt = territorioAtivo?.info?.codigo;

  const fFilt = geojsonData.features.filter(f => {
    const it = dadosTerritorios.find(t => t.codigo === f.properties.name);
    if (!it) return false;
    return (cSel === 'TODAS' || it.congregacao === cSel) &&
           (sSel === 'TODOS' || it.status === sSel);
  });

  geojsonLayer = L.geoJSON({ type: 'FeatureCollection', features: fFilt }, {
    style: f => obterEstilo(f.properties.name),
    onEachFeature: (f, l) => {
      l.bindTooltip(f.properties.name, { permanent: false, direction: 'center', className: 'label-territorio' });
      l.on('click', () => abrirPainel(f.properties.name, l));
    }
  }).addTo(map);

  if (codAt) {
    let enc = false;
    geojsonLayer.eachLayer(l => {
      if (l.feature.properties.name === codAt) {
        l.setStyle({ weight: 5, color: '#FFFFFF', fillOpacity: 0.85 });
        l.bringToFront();
        camadaDestacada = l;
        territorioAtivo.layer = l;
        enc = true;
      }
    });
    if (!enc) fecharPainel();
  }

  if (autoZoom && geojsonLayer.getLayers().length > 0) {
    map.fitBounds(geojsonLayer.getBounds(), { padding: [40, 40] });
  }

  atualizarContador(fFilt.length, cSel, sSel);
  renderizarMarcadores();
  renderizarCoordenadas();
}

function atualizarContador(total, cSel, sSel) {
  const el = document.getElementById('contador-texto');
  if (!el) return;
  const nc = cSel === 'TODAS' ? 'Todas as congregações' : CONGREGACOES[cSel]?.nome;
  const ns = sSel === 'TODOS' ? '' : ` · ${sSel}`;
  el.innerText = `${total} território${total !== 1 ? 's' : ''} · ${nc}${ns}`;
  const cont = document.getElementById('contador-territorios');
  if (cont) cont.style.background = cSel === 'TODAS' ? 'rgba(69,90,100,0.95)' : CONGREGACOES[cSel]?.cor;
}

// =====================================================================
// 🧭 BOTTOM SHEET + FICHA + MENU
// =====================================================================
function abrirPainel(cod, l) {
  if (modoMarcacaoAtivo || modoDesenhoAtivo || modoEdicaoAtivo) return;
  const it = dadosTerritorios.find(t => t.codigo === cod);
  if (!it) return;

  if (camadaDestacada && geojsonLayer) geojsonLayer.resetStyle(camadaDestacada);
  territorioAtivo = { info: it, layer: l };
  camadaDestacada = l;

  l.setStyle({ weight: 5, color: '#FFFFFF', fillOpacity: it.status === 'Livre' ? 0.55 : 0.85 });
  l.bringToFront();

  // ✅ Padding assimétrico para não ficar sob o bottom sheet
  map.fitBounds(l.getBounds(), {
    paddingTopLeft: [40, 120],
    paddingBottomRight: [40, 220],
    maxZoom: 17
  });

  atualizarBottomSheet(it);
  atualizarFichaCompleta(it);
  atualizarListaPontosDOM();
  destacarCoordenadaAtiva();

  document.getElementById('bottom-sheet').classList.remove('oculto');
}

function atualizarBottomSheet(it) {
  const codEl = document.getElementById('bs-codigo');
  if (!codEl) return;

  codEl.innerText = it.codigo;
  const badge = document.getElementById('bs-badge');
  badge.innerText = it.status;
  badge.className = `bs-badge badge-${it.status.toLowerCase()}`;

  document.getElementById('bs-publicador').innerText = it.publicador || 'Ninguém designado';
  document.getElementById('bs-saida').innerText = it.dataSaida || '--/--/----';

  // Botão Rota
  const btnRota = document.querySelector('.bs-btn-rota');
  if (btnRota) {
    const temCoord = !!it.coordenada;
    btnRota.disabled = !temCoord;
    btnRota.style.opacity = temCoord ? '1' : '0.5';
    btnRota.style.cursor = temCoord ? 'pointer' : 'not-allowed';
  }

  // Item "Limpar coordenada" no menu
  const limparItem = document.getElementById('menu-item-limpar-coord');
  if (limparItem) limparItem.style.display = it.coordenada ? 'flex' : 'none';
}

function atualizarFichaCompleta(it) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
  set('det-congregacao', nomeCongregacao(it.congregacao));
  set('det-publicador', it.publicador || 'Ninguém designado');
  set('det-saida', it.dataSaida || '--/--/----');
  set('det-conclusao', it.dataConclusao || '--/--/----');
  set('det-qtd-pontos', (it.pontos || []).length);
  set('det-coordenada', it.coordenada ? `${it.coordenada.lat}, ${it.coordenada.lng}` : 'Nenhuma');
  const u = it.ultimaAlteracao?.toDate ? it.ultimaAlteracao.toDate().toLocaleString('pt-BR') : '---';
  set('det-ultima-alt', u);
}

function abrirDetalhes() {
  document.getElementById('painel-detalhes').classList.remove('oculto');
}

function fecharDetalhes() {
  document.getElementById('painel-detalhes').classList.add('oculto');
}

function fecharPainel() {
  document.getElementById('bottom-sheet').classList.add('oculto');
  document.getElementById('painel-detalhes').classList.add('oculto');
  fecharMenuFlutuante();

  if (camadaDestacada && geojsonLayer) geojsonLayer.resetStyle(camadaDestacada);
  if (marcadorCoordenadaAtiva) {
    map.removeLayer(marcadorCoordenadaAtiva);
    marcadorCoordenadaAtiva = null;
  }
  territorioAtivo = null;
  camadaDestacada = null;
  desativarModoMarcacao();
}

// ═══════════════════════════════════════════════════════════════════
// ⋮ MENU FLUTUANTE
// ═══════════════════════════════════════════════════════════════════
function toggleMenuFlutuante() {
  const menu = document.getElementById('menu-flutuante');
  const overlay = document.getElementById('menu-overlay');
  if (menu.classList.contains('oculto')) {
    menu.classList.remove('oculto');
    overlay.classList.remove('oculto');
  } else {
    fecharMenuFlutuante();
  }
}

function fecharMenuFlutuante() {
  document.getElementById('menu-flutuante')?.classList.add('oculto');
  document.getElementById('menu-overlay')?.classList.add('oculto');
}

// =====================================================================
// 🔥 GRAVAÇÃO
// =====================================================================
async function gravarTerritorio(t, op) {
  try {
    const ref = db.collection('territorios').doc(t.codigo);
    await ref.update({
      congregacao: t.congregacao, status: t.status, publicador: t.publicador,
      dataSaida: t.dataSaida, dataConclusao: t.dataConclusao,
      coordenada: t.coordenada, pontos: t.pontos,
      ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
      ultimoUsuario: usuarioAtual
    });
    await ref.collection('historico').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: t.status, publicador: t.publicador,
      dataSaida: t.dataSaida, dataConclusao: t.dataConclusao,
      operacao: op, usuario: usuarioAtual
    });
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
}

// =====================================================================
// 🎬 STATUS
// =====================================================================
async function acaoDesignar() {
  if (!territorioAtivo) return;
  const p = prompt("Nome do Publicador:", territorioAtivo.info.publicador);
  if (p && p.trim()) {
    territorioAtivo.info.publicador = p;
    territorioAtivo.info.status = 'Designado';
    territorioAtivo.info.dataSaida = new Date().toLocaleDateString('pt-BR');
    await gravarTerritorio(territorioAtivo.info, 'designacao');
  }
}

async function alterarStatus(ns) {
  if (!territorioAtivo) return;
  if (ns === 'Trabalhando' && !territorioAtivo.info.publicador) {
    const p = prompt("Quem está trabalhando?");
    if (p) {
      territorioAtivo.info.publicador = p;
      territorioAtivo.info.dataSaida = new Date().toLocaleDateString('pt-BR');
    } else return;
  }
  let op = 'inicio_trabalho';
  if (ns === 'Concluído') op = 'conclusao';
  else if (ns === 'Livre') op = 'liberacao';
  territorioAtivo.info.status = ns;
  const h = new Date().toLocaleDateString('pt-BR');
  if (ns === 'Concluído') territorioAtivo.info.dataConclusao = h;
  else if (ns === 'Livre') {
    territorioAtivo.info.publicador = '';
    territorioAtivo.info.dataSaida = '';
  }
  await gravarTerritorio(territorioAtivo.info, op);
}

// =====================================================================
// 📍 GPS
// =====================================================================
function capturarCoordenadaGPS() {
  if (!territorioAtivo) return alert('Nenhum território selecionado.');
  if (!navigator.geolocation) return alert('GPS não suportado.');

  navigator.geolocation.getCurrentPosition(async p => {
    const lat = +p.coords.latitude.toFixed(6);
    const lng = +p.coords.longitude.toFixed(6);
    const pr = Math.round(p.coords.accuracy);

    let d = false;
    try {
      d = turf.booleanPointInPolygon(turf.point([lng, lat]), territorioAtivo.layer.feature);
    } catch (e) {}

    if (!d && !confirm(
      `⚠️ Você está fora do polígono.\n\nLat: ${lat}\nLng: ${lng}\nPrecisão: ±${pr} m\n\nGravar mesmo assim?`
    )) return;

    territorioAtivo.info.coordenada = { lat, lng };
    await gravarTerritorio(territorioAtivo.info, 'coordenada');
    alert(`✅ Coordenada salva!\nLat: ${lat}\nLng: ${lng}\nPrecisão: ±${pr} m`);
  }, e => {
    alert('Erro GPS: ' + e.message);
  }, { enableHighAccuracy: true, timeout: 15000 });
}

function tracarRotaAteCoordenada() {
  if (!territorioAtivo?.info?.coordenada) return alert('Sem coordenada.');
  const d = territorioAtivo.info.coordenada;
  let u = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=driving`;
  if (coordenadasGPS?.lat) u += `&origin=${coordenadasGPS.lat},${coordenadasGPS.lng}`;
  window.open(u, '_blank');
}

async function limparCoordenada() {
  if (!territorioAtivo?.info?.coordenada) return;
  if (!confirm('Remover a coordenada marcada?')) return;
  territorioAtivo.info.coordenada = null;
  await gravarTerritorio(territorioAtivo.info, 'coordenada');
}

function atualizarInterfaceCoordenada() {
  const temCoord = !!territorioAtivo?.info?.coordenada;
  const limparItem = document.getElementById('menu-item-limpar-coord');
  if (limparItem) limparItem.style.display = temCoord ? 'flex' : 'none';
  const btnRota = document.querySelector('.bs-btn-rota');
  if (btnRota) {
    btnRota.disabled = !temCoord;
    btnRota.style.opacity = temCoord ? '1' : '0.5';
  }
}

function renderizarCoordenadas() {
  camadaCoordenadas.clearLayers();
  if (!geojsonLayer) return;
  const v = new Set(geojsonLayer.getLayers().map(l => l.feature.properties.name));
  dadosTerritorios.filter(t => v.has(t.codigo) && t.coordenada).forEach(t => {
    camadaCoordenadas.addLayer(
      L.marker([t.coordenada.lat, t.coordenada.lng], {
        icon: L.divIcon({ className: 'marcador-coordenada', html: '📍', iconSize: [26, 26], iconAnchor: [13, 26] })
      }).bindPopup(`<b>${t.codigo}</b><br>${t.coordenada.lat}, ${t.coordenada.lng}`)
    );
  });
}

function destacarCoordenadaAtiva() {
  if (marcadorCoordenadaAtiva) { map.removeLayer(marcadorCoordenadaAtiva); marcadorCoordenadaAtiva = null; }
  const c = territorioAtivo?.info?.coordenada;
  if (!c) return;
  marcadorCoordenadaAtiva = L.marker([c.lat, c.lng], {
    icon: L.divIcon({ className: 'marcador-coordenada-ativa', html: '🎯', iconSize: [34, 34], iconAnchor: [17, 34] })
  }).addTo(map).bindPopup(`Coordenada: ${territorioAtivo.info.codigo}`).openPopup();
}

// =====================================================================
// 📝 ANOTAÇÕES
// =====================================================================
function alternarModoMarcacao() {
  if (!territorioAtivo) return;
  modoMarcacaoAtivo = !modoMarcacaoAtivo;
  if (modoMarcacaoAtivo) {
    document.getElementById('map').classList.add('modo-marcacao-ativo');
    alert("📍 Toque dentro do território para adicionar uma anotação.");
  } else {
    desativarModoMarcacao();
  }
}

function desativarModoMarcacao() {
  modoMarcacaoAtivo = false;
  document.getElementById('map')?.classList.remove('modo-marcacao-ativo');
}

map.on('click', async e => {
  // Fecha o menu flutuante se estiver aberto (mas não estava em modo marcação)
  if (!modoMarcacaoAtivo) {
    fecharMenuFlutuante();
    return;
  }

  if (!territorioAtivo) return;
  const pt = turf.point([e.latlng.lng, e.latlng.lat]);
  if (!territorioAtivo.layer?.feature) { desativarModoMarcacao(); return; }
  if (!turf.booleanPointInPolygon(pt, territorioAtivo.layer.feature)) {
    alert("Fora dos limites do território.");
    return;
  }
  const d = prompt("Descrição da anotação:");
  if (!d) { desativarModoMarcacao(); return; }
  if (!territorioAtivo.info.pontos) territorioAtivo.info.pontos = [];
  territorioAtivo.info.pontos.push({
    id: Date.now(), descricao: d,
    lat: e.latlng.lat.toFixed(6), lng: e.latlng.lng.toFixed(6)
  });
  await gravarTerritorio(territorioAtivo.info, 'anotacao');
  desativarModoMarcacao();
});

function renderizarMarcadores() {
  camadaMarcadores.clearLayers();
  const c = document.getElementById('filtro-congregacao').value;
  dadosTerritorios.filter(t => c === 'TODAS' || t.congregacao === c).forEach(t => {
    (t.pontos || []).forEach(p => {
      camadaMarcadores.addLayer(
        L.circleMarker([p.lat, p.lng], { radius: 6, color: '#D32F2F', fillColor: '#FF5252', fillOpacity: 1 })
          .bindPopup(`<b>${t.codigo}</b><br>${p.descricao}`)
      );
    });
  });
}

function atualizarListaPontosDOM() {
  const ul = document.getElementById('lista-pontos');
  if (!ul) return;
  ul.innerHTML = '';
  const ps = territorioAtivo?.info?.pontos || [];
  if (!ps.length) { ul.innerHTML = '<li style="color:#888;text-align:center;">Nenhuma.</li>'; return; }
  ps.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.descricao}</span>
      <div>
        <button onclick="tracarRotaAteCoordenadaDoPonto(${p.lat},${p.lng})" style="background:none;border:none;cursor:pointer;font-size:16px;">🚗</button>
        <button class="btn-del-ponto" onclick="removerPonto(${p.id})">✕</button>
      </div>`;
    ul.appendChild(li);
  });
}

async function removerPonto(id) {
  if (!confirm("Remover?")) return;
  territorioAtivo.info.pontos = territorioAtivo.info.pontos.filter(p => p.id !== id);
  await gravarTerritorio(territorioAtivo.info, 'anotacao');
}

function tracarRotaAteCoordenadaDoPonto(lat, lng) {
  let u = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  if (coordenadasGPS?.lat) u += `&origin=${coordenadasGPS.lat},${coordenadasGPS.lng}`;
  window.open(u, '_blank');
}

// =====================================================================
// ➕ ADMIN
// =====================================================================
function abrirPainelAdmin() { document.getElementById('painel-admin').classList.remove('oculto'); }
function fecharPainelAdmin() { document.getElementById('painel-admin').classList.add('oculto'); }

function iniciarNovoTerritorio() {
  fecharPainelAdmin();
  if (modoDesenhoAtivo) return cancelarDesenho();
  modoDesenhoAtivo = true;
  pontosDesenho = [];
  document.getElementById('map').style.cursor = 'crosshair';
  document.getElementById('barra-desenho').classList.remove('oculto');
  document.getElementById('desenho-status').innerText = 'Toque no mapa para adicionar vértices...';
  map.on('click', adicionarPontoDesenho);
}

function adicionarPontoDesenho(e) {
  if (!modoDesenhoAtivo) return;
  pontosDesenho.push([e.latlng.lng, e.latlng.lat]);
  if (!editorPoligono) {
    editorPoligono = L.polygon(pontosDesenho.map(p => [p[1], p[0]]), {
      color: '#ff5722', weight: 3, fillOpacity: 0.4, dashArray: '6,6'
    }).addTo(map);
  } else {
    editorPoligono.setLatLngs(pontosDesenho.map(p => [p[1], p[0]]));
  }
  document.getElementById('desenho-status').innerText = `${pontosDesenho.length} vértice(s). Toque em ✅ Salvar.`;
}

async function finalizarDesenho() {
  if (pontosDesenho.length < 3) return alert("Adicione pelo menos 3 pontos.");
  const cAtual = document.getElementById('filtro-congregacao').value;
  const cVal = cAtual === 'TODAS' ? 'jardins' : cAtual;
  const sugerido = proximoCodigo(cVal);
  const cod = prompt(`Código do novo território (${nomeCongregacao(cVal)}):`, sugerido);
  if (!cod) return;
  if (dadosTerritorios.some(t => t.codigo === cod)) return alert(`Já existe "${cod}".`);

  const cFin = congregacaoPorPrefixo(cod);
  const cds = [...pontosDesenho];
  if (JSON.stringify(cds[0]) !== JSON.stringify(cds[cds.length - 1])) cds.push(cds[0]);

  try {
    const ref = db.collection('territorios').doc(cod);
    const geometry = { type: 'Polygon', coordinates: [cds] };

    await ref.set({
      congregacao: cFin,
      status: 'Livre',
      publicador: '',
      dataSaida: '',
      dataConclusao: '',
      coordenada: null,
      pontos: [],
      geometry: JSON.stringify(geometry),
      ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
      ultimoUsuario: usuarioAtual
    });

    await ref.collection('historico').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'Livre',
      publicador: '',
      dataSaida: '',
      dataConclusao: '',
      operacao: 'criacao_poligono',
      usuario: usuarioAtual
    });

    alert(`✅ ${cod} criado em ${nomeCongregacao(cFin)}.`);
    cancelarDesenho();
  } catch (e) { alert('Erro: ' + e.message); }
}

function cancelarDesenho() {
  modoDesenhoAtivo = false;
  pontosDesenho = [];
  map.off('click', adicionarPontoDesenho);
  if (editorPoligono) { map.removeLayer(editorPoligono); editorPoligono = null; }
  document.getElementById('map').style.cursor = '';
  document.getElementById('barra-desenho').classList.add('oculto');
}

// =====================================================================
// ✏️ EDITAR FORMA
// =====================================================================
function editarPoligonoAtivo() {
  if (!territorioAtivo?.layer) return;

  // Fecha UI mas mantém territorioAtivo
  document.getElementById('bottom-sheet').classList.add('oculto');
  document.getElementById('painel-detalhes').classList.add('oculto');
  fecharMenuFlutuante();

  modoEdicaoAtivo = true;
  poligonoSendoEditado = territorioAtivo.layer;
  poligonoSendoEditado.setStyle({ color: '#FF5722', weight: 4, dashArray: '6,6' });

  const ll = poligonoSendoEditado.getLatLngs()[0];
  const ms = [];
  ll.forEach((p, i) => {
    const m = L.marker(p, {
      draggable: true,
      icon: L.divIcon({ className: 'vertice-editavel', html: '●', iconSize: [16, 16] })
    }).addTo(map);
    m.on('drag', e => {
      ll[i] = e.target.getLatLng();
      poligonoSendoEditado.setLatLngs([ll]);
    });
    ms.push(m);
  });
  poligonoSendoEditado._marcadoresEdicao = ms;
  document.getElementById('barra-edicao').classList.remove('oculto');
}

async function salvarEdicaoPoligono() {
  if (!poligonoSendoEditado) return;
  const ll = poligonoSendoEditado.getLatLngs()[0];
  const cds = ll.map(p => [p.lng, p.lat]);
  if (JSON.stringify(cds[0]) !== JSON.stringify(cds[cds.length - 1])) cds.push(cds[0]);

  const cod = territorioAtivo.info.codigo;
  const geometry = { type: 'Polygon', coordinates: [cds] };

  try {
    await db.collection('territorios').doc(cod).update({
      geometry: JSON.stringify(geometry),
      ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
      ultimoUsuario: usuarioAtual
    });

    await db.collection('territorios').doc(cod).collection('historico').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: territorioAtivo.info.status,
      publicador: territorioAtivo.info.publicador,
      dataSaida: territorioAtivo.info.dataSaida,
      dataConclusao: territorioAtivo.info.dataConclusao,
      operacao: 'edicao_poligono',
      usuario: usuarioAtual
    });

    alert('✅ Forma atualizada.');
    cancelarEdicaoPoligono();
  } catch (e) { alert('Erro: ' + e.message); }
}

function cancelarEdicaoPoligono() {
  modoEdicaoAtivo = false;
  if (poligonoSendoEditado) {
    (poligonoSendoEditado._marcadoresEdicao || []).forEach(m => map.removeLayer(m));
    poligonoSendoEditado._marcadoresEdicao = null;
    poligonoSendoEditado = null;
  }
  document.getElementById('barra-edicao').classList.add('oculto');
}

// =====================================================================
// 🔀 MOVER CONGREGAÇÃO
// =====================================================================
async function moverCongregacao() {
  if (!territorioAtivo) return;
  const at = territorioAtivo.info.congregacao;
  const ca = territorioAtivo.info.codigo;
  const op = Object.keys(CONGREGACOES)
    .filter(k => k !== at)
    .map(k => `${k} = ${CONGREGACOES[k].nome}`)
    .join('\n');
  const nv = prompt(`Mover "${ca}"?\n\n${op}\n\nChave:`);
  if (!nv || !CONGREGACOES[nv]) return alert('Inválido.');

  const nc = proximoCodigo(nv);
  if (!confirm(`Mover para ${nomeCongregacao(nv)}?\n\nNovo código: ${nc}`)) return;

  try {
    const ar = db.collection('territorios').doc(ca);
    const nr = db.collection('territorios').doc(nc);
    const d = territorioAtivo.info;
    const geometry = territorioAtivo.layer.feature.geometry;

    await nr.set({
      congregacao: nv,
      status: d.status,
      publicador: d.publicador,
      dataSaida: d.dataSaida,
      dataConclusao: d.dataConclusao,
      coordenada: d.coordenada,
      pontos: d.pontos,
      geometry: JSON.stringify(geometry),
      ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
      ultimoUsuario: usuarioAtual
    });

    await nr.collection('historico').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: d.status,
      publicador: d.publicador,
      dataSaida: d.dataSaida,
      dataConclusao: d.dataConclusao,
      operacao: 'mudanca_congregacao',
      usuario: usuarioAtual,
      codigoAnterior: ca
    });

    await ar.delete();
    alert(`✅ Agora é ${nc}.`);
    fecharPainel();
  } catch (e) { alert('Erro: ' + e.message); }
}

// =====================================================================
// 🗑️ EXCLUIR
// =====================================================================
async function excluirTerritorioAtivo() {
  if (!territorioAtivo) return;
  const c = territorioAtivo.info.codigo;
  if (prompt(`⚠️ Excluir "${c}"?\n\nDigite o código:`) !== c) return;
  try {
    const r = db.collection('territorios').doc(c);
    await r.collection('historico').add({
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      status: 'EXCLUIDO',
      publicador: territorioAtivo.info.publicador || '',
      dataSaida: '',
      dataConclusao: '',
      operacao: 'exclusao',
      usuario: usuarioAtual
    });
    await r.delete();
    alert('Excluído.');
    fecharPainel();
  } catch (e) { alert('Erro: ' + e.message); }
}

// =====================================================================
// 📜 HISTÓRICO
// =====================================================================
async function abrirHistoricoTerritorio() {
  if (!territorioAtivo) return;
  document.getElementById('hist-titulo').innerText = `Histórico — ${territorioAtivo.info.codigo}`;
  await renderizarHistorico(db.collection('territorios').doc(territorioAtivo.info.codigo).collection('historico'));
  document.getElementById('modal-historico').classList.remove('oculto');
}

async function abrirHistoricoGlobal() {
  fecharPainelAdmin();
  document.getElementById('hist-titulo').innerText = 'Histórico geral';
  const ul = document.getElementById('hist-lista');
  ul.innerHTML = '<li>Carregando...</li>';
  try {
    const ts = await db.collection('territorios').get();
    const all = [];
    for (const t of ts.docs) {
      const hs = await t.ref.collection('historico').orderBy('timestamp', 'desc').limit(5).get();
      hs.forEach(h => all.push({ codigo: t.id, ...h.data() }));
    }
    all.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
    ul.innerHTML = '';
    all.slice(0, 100).forEach(d => {
      const tst = d.timestamp?.toDate ? d.timestamp.toDate().toLocaleString('pt-BR') : '---';
      const li = document.createElement('li');
      li.innerHTML = `<div><strong>${d.codigo}</strong> · ${d.operacao} · ${d.status}</div>
        <div style="font-size:12px;color:#555;">${d.publicador || 'sem responsável'}</div>
        <div style="font-size:11px;color:#888;">${tst}</div>`;
      ul.appendChild(li);
    });
  } catch { ul.innerHTML = '<li>Erro.</li>'; }
  document.getElementById('modal-historico').classList.remove('oculto');
}

async function renderizarHistorico(ref) {
  const ul = document.getElementById('hist-lista');
  ul.innerHTML = '<li>Carregando...</li>';
  try {
    const s = await ref.orderBy('timestamp', 'desc').limit(50).get();
    ul.innerHTML = '';
    if (s.empty) { ul.innerHTML = '<li>Sem registros.</li>'; return; }
    s.forEach(doc => {
      const d = doc.data();
      const tst = d.timestamp?.toDate ? d.timestamp.toDate().toLocaleString('pt-BR') : '---';
      const li = document.createElement('li');
      li.innerHTML = `<div><strong>${d.operacao}</strong> · ${d.status}</div>
        <div style="font-size:12px;color:#555;">${d.publicador || 'sem responsável'}</div>
        <div style="font-size:11px;color:#888;">${tst}</div>`;
      ul.appendChild(li);
    });
  } catch { ul.innerHTML = '<li>Erro.</li>'; }
}

function fecharHistorico() { document.getElementById('modal-historico').classList.add('oculto'); }

// =====================================================================
// 📊 ESTATÍSTICAS
// =====================================================================
function estatisticasCongregacoes() {
  fecharPainelAdmin();
  const c = document.getElementById('stats-conteudo');
  const st = {};
  Object.keys(CONGREGACOES).forEach(k => st[k] = { Livre: 0, Designado: 0, Trabalhando: 0, Concluído: 0, total: 0 });
  dadosTerritorios.forEach(t => {
    const s = st[t.congregacao]; if (!s) return;
    s[t.status] = (s[t.status] || 0) + 1;
    s.total++;
  });
  let h = '<table style="width:100%;border-collapse:collapse;">';
  h += '<tr style="background:#f5f5f5;"><th style="padding:8px;text-align:left;">Congregação</th><th>🟢</th><th>🟠</th><th>🟡</th><th>🔵</th><th>Total</th></tr>';
  Object.entries(st).forEach(([k, v]) => {
    h += `<tr><td style="padding:8px;font-weight:bold;">${CONGREGACOES[k].nome}<br><small style="color:#777;">${CONGREGACOES[k].prefixo}XXX</small></td>
      <td style="text-align:center;">${v.Livre}</td>
      <td style="text-align:center;">${v.Designado}</td>
      <td style="text-align:center;">${v.Trabalhando}</td>
      <td style="text-align:center;">${v.Concluído}</td>
      <td style="text-align:center;font-weight:bold;">${v.total}</td></tr>`;
  });
  h += '</table>';
  c.innerHTML = h;
  document.getElementById('modal-stats').classList.remove('oculto');
}
function fecharStats() { document.getElementById('modal-stats').classList.add('oculto'); }

// =====================================================================
// 📥 IMPORTAR GEOJSON
// =====================================================================
function importarGeojsonManual() {
  fecharPainelAdmin();
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = '.geojson,.json';

  i.onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const texto = await f.text();
      const g = JSON.parse(texto);
      if (!g.features?.length) return alert('Arquivo sem features.');

      const b = db.batch();
      let c = 0;
      g.features.forEach(ft => {
        const cod = ft.properties?.name;
        if (!cod) return;
        const ref = db.collection('territorios').doc(cod);
        b.set(ref, {
          congregacao: congregacaoPorPrefixo(cod),
          status: 'Livre',
          publicador: '',
          dataSaida: '',
          dataConclusao: '',
          coordenada: null,
          pontos: [],
          geometry: JSON.stringify(ft.geometry),
          ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
          ultimoUsuario: usuarioAtual
        }, { merge: true });
        b.set(ref.collection('historico').doc(), {
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          status: 'Livre',
          publicador: '',
          dataSaida: '',
          dataConclusao: '',
          operacao: 'importacao_geojson',
          usuario: usuarioAtual
        });
        c++;
      });
      await b.commit();
      alert(`✅ ${c} territórios importados.`);
    } catch (e) { alert('Erro ao importar: ' + e.message); }
  };
  i.click();
}

// =====================================================================
// 📥 IMPORTAR KML
// =====================================================================
function importarKML() {
  fecharPainelAdmin();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.kml,application/vnd.google-earth.kml+xml';

  input.onchange = async (e) => {
    const arquivo = e.target.files[0];
    if (!arquivo) return;
    const texto = await arquivo.text();
    let placemarks;
    try { placemarks = extrairPlacemarksDoKML(texto); }
    catch (err) { return alert('❌ Erro ao ler KML: ' + err.message); }

    if (placemarks.length === 0) {
      return alert('❌ Nenhum polígono encontrado no KML.');
    }

    const duplicados = placemarks.filter(p => dadosTerritorios.some(t => t.codigo === p.nome));
    let acao = 'substituir';
    if (duplicados.length > 0) {
      const resposta = prompt(
        `⚠️ ${duplicados.length} território(s) já existem:\n` +
        duplicados.map(p => `  • ${p.nome}`).join('\n') +
        `\n\nDigite:\n  S → Substituir\n  R → Renomear\n  C → Cancelar`,
        'S'
      );
      if (!resposta) return;
      const letra = resposta.trim().toUpperCase();
      if (letra === 'C') return;
      if (letra === 'R') acao = 'renomear';
    }

    const codigosExistentes = new Set(dadosTerritorios.map(t => t.codigo));
    placemarks.forEach(p => {
      if (codigosExistentes.has(p.nome) && acao === 'renomear') {
        const cong = congregacaoPorPrefixo(p.nome);
        p.nome = proximoCodigo(cong);
      }
      codigosExistentes.add(p.nome);
    });

    const batch = db.batch();
    let importados = 0;
    placemarks.forEach(p => {
      const cong = congregacaoPorPrefixo(p.nome);
      const ref = db.collection('territorios').doc(p.nome);
      batch.set(ref, {
        congregacao: cong,
        status: 'Livre',
        publicador: '',
        dataSaida: '',
        dataConclusao: '',
        coordenada: null,
        pontos: [],
        geometry: JSON.stringify(p.geometry),
        ultimaAlteracao: firebase.firestore.FieldValue.serverTimestamp(),
        ultimoUsuario: usuarioAtual
      }, { merge: acao === 'substituir' });
      batch.set(ref.collection('historico').doc(), {
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'Livre',
        publicador: '',
        dataSaida: '',
        dataConclusao: '',
        operacao: 'importacao_kml',
        usuario: usuarioAtual,
        nomeOriginal: p.nomeOriginal || p.nome
      });
      importados++;
    });

    try {
      await batch.commit();
      alert(`✅ ${importados} território(s) importado(s) do KML!`);
    } catch (err) {
      console.error(err);
      alert('❌ Erro ao gravar: ' + err.message);
    }
  };
  input.click();
}

function extrairPlacemarksDoKML(textoKML) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(textoKML, 'application/xml');
  const erroParser = xml.querySelector('parsererror');
  if (erroParser) throw new Error('Arquivo KML inválido.');

  const placemarks = [];
  const nodes = xml.getElementsByTagName('Placemark');

  for (let i = 0; i < nodes.length; i++) {
    const pm = nodes[i];
    const nameNode = pm.getElementsByTagName('name')[0];
    const nomeOriginal = nameNode ? nameNode.textContent.trim() : `territorio_${i + 1}`;
    const nome = nomeOriginal.replace(/\s+/g, '_').replace(/[^\w\-]/g, '');

    const polygonNodes = pm.getElementsByTagName('Polygon');
    if (polygonNodes.length === 0) continue;

    const polygon = polygonNodes[0];
    const aneis = [];

    const outer = polygon.getElementsByTagName('outerBoundaryIs')[0];
    if (outer) {
      const outerCoords = outer.getElementsByTagName('coordinates')[0];
      if (outerCoords) aneis.push(parseCoordenadasKML(outerCoords.textContent));
    }
    const inners = polygon.getElementsByTagName('innerBoundaryIs');
    for (let j = 0; j < inners.length; j++) {
      const c = inners[j].getElementsByTagName('coordinates')[0];
      if (c) aneis.push(parseCoordenadasKML(c.textContent));
    }
    if (aneis.length === 0) continue;

    placemarks.push({
      nome, nomeOriginal,
      geometry: { type: 'Polygon', coordinates: aneis }
    });
  }
  return placemarks;
}

function parseCoordenadasKML(texto) {
  return texto.trim().split(/\s+/)
    .map(par => par.split(','))
    .filter(p => p.length >= 2)
    .map(p => [parseFloat(p[0]), parseFloat(p[1])])
    .filter(p => !isNaN(p[0]) && !isNaN(p[1]));
}

// =====================================================================
// 🔄 RECARREGAR
// =====================================================================
function recarregarTudo() {
  fecharPainelAdmin();
  if (unsubscribeTerritorios) unsubscribeTerritorios();
  escutarTerritorios();
  alert('🔄 Recarregando...');
}

// =====================================================================
// 📡 GPS EM TEMPO REAL
// =====================================================================
function ativarGPS() {
  if (!navigator.geolocation) return alert('GPS não suportado.');
  const b = document.getElementById('btn-gps');
  b.innerText = "⏳";
  navigator.geolocation.watchPosition(p => {
    coordenadasGPS = { lat: p.coords.latitude, lng: p.coords.longitude };
    b.innerText = "📍";
    b.style.background = "#0F9D58";
    if (!marcadorGPS) {
      marcadorGPS = L.circleMarker([coordenadasGPS.lat, coordenadasGPS.lng], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#1976d2', fillOpacity: 1
      }).addTo(map).bindPopup('Você está aqui');
    } else {
      marcadorGPS.setLatLng([coordenadasGPS.lat, coordenadasGPS.lng]);
    }
  }, () => { b.innerText = "📍"; alert('Erro GPS.'); }, { enableHighAccuracy: true });
}

// =====================================================================
// 🚀 INICIALIZAÇÃO
// =====================================================================
(async function () {
  await autenticar();
  escutarTerritorios();
})();

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (modoDesenhoAtivo) cancelarDesenho();
    if (modoEdicaoAtivo) cancelarEdicaoPoligono();
    if (modoMarcacaoAtivo) desativarModoMarcacao();
    fecharMenuFlutuante();
  }
});