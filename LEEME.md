# Rotador (PWA)

App web para controlar vencimientos y pedir precios. Funciona en el celular, con y sin internet.

## Cómo publicarla (gratis, una sola vez)
La app necesita **HTTPS** para que funcione la cámara y el modo sin conexión. Dos opciones fáciles:

**Netlify Drop (la más rápida)**
1. Entra a https://app.netlify.com/drop
2. Descomprime este .zip y arrastra la carpeta `rotador` a la página.
3. Te da un enlace `https://...netlify.app`. Ese es tu enlace.

**GitHub Pages**
1. Crea un repositorio y sube el contenido de la carpeta `rotador`.
2. En Settings → Pages elige la rama principal. El enlace queda `https://usuario.github.io/repositorio/`.

## Cómo instalarla en el teléfono
1. Abre el enlace **con internet** (se descarga todo la primera vez).
2. iPhone: Safari → Compartir → "Agregar a pantalla de inicio".
   Android: Chrome → menú ⋮ → "Instalar app".
3. Ábrela desde el ícono. Ya funciona sin conexión.

## Uso rápido
- **Agregar**: escanea el código (📷) o escríbelo; nombre, proveedor, lote, vencimiento y cantidad (und o kg). Si el producto ya existe, solo se suma un lote nuevo.
- **Inicio**: lotes ordenados por fecha de retiro (vencimiento − 1 día). Rojo = retirar hoy o atrasado.
- **Pedir precios**: lotes que vencen en 7 días o menos. Elige Precio o 2x1 por lote, genera el PDF y compártelo. Al día siguiente, marca ✅ o ❌ en "Por verificar".
- **Días de pedir**: lunes y jueves; martes y viernes si el lunes es festivo o hay promoción (Ajustes).
- **Ajustes → Exportar copia**: guarda una copia de tus datos de vez en cuando.

## Si actualizas la app
Si cambias algún archivo, edita `sw.js` y sube el número de `CACHE` (por ejemplo `rotador-v2`) para que los teléfonos descarguen la versión nueva.
