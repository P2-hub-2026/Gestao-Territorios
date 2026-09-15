# 🗺️ Gestão Territórios

Aplicativo web/PWA para gestão de territórios de pregação das congregações:
- 🏘️ **Jardins** (`jrdTerXXX`)
- 🌄 **Bela Vista** (`bvTerXXX`)
- 🏛️ **Central** (`ctlTerXXX`)

## ✨ Funcionalidades

- Mapa satélite (Leaflet + Google)
- Filtro estrito por congregação
- Cadastro, edição e exclusão de polígonos no mapa
- Importação de territórios via **KML** (Google My Maps)
- Importação de territórios via **GeoJSON**
- Marcação de coordenada GPS por território
- Rota até a coordenada no Google Maps
- Anotações dentro de cada território
- Histórico completo e imutável de alterações
- Sincronização em tempo real entre múltiplos usuários (Firestore)
- Estatísticas por congregação
- PWA instalável no celular

## 🛠️ Tecnologias

- **Leaflet.js** — mapas
- **Turf.js** — cálculos geométricos
- **Firebase Firestore** — banco de dados em tempo real
- **Firebase Auth (anônimo)** — identificação de usuário
- **GitHub Pages** — hospedagem gratuita

## ⚙️ Configuração

1. Crie um projeto em https://console.firebase.google.com
2. Ative o **Firestore** (modo produção)
3. Ative **Authentication → Anonymous**
4. Copie as credenciais em **Configurações → Seus apps → Web**
5. Cole no topo do `app.js` dentro de `firebaseConfig`
6. Aplique as regras do Firestore (veja abaixo)

### Regras do Firestore

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /territorios/{territorio} {
      allow read: if true;
      allow create, update: if request.auth != null;
      allow delete: if false;
      match /historico/{hist} {
        allow read: if true;
        allow create: if request.auth != null;
        allow update, delete: if false;
      }
    }
  }
}