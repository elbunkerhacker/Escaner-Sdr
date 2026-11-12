<h1 align="center">Escáner SDR de el Búnker Hacker</h1>

<p align="center">
  Escáner de frecuencias en el navegador para un dongle <b>RTL-SDR</b>:<br>
  barre bandas, muestra espectro y cascada, detecta señales y las escucha en FM y AM.
</p>

<p align="center">
  <img src="docs/capturas/barrido-fm.png" alt="Barrido de la banda FM con señales detectadas y etiquetas" width="900">
</p>

## Qué hace

- **Barrido de frecuencias** de 24 a 1766 MHz (R820T) con espectro, retención de picos y cascada.
- **Detección automática de señales** sobre el ruido, con tabla, etiquetas propias y exportación a CSV.
- **Escucha en FM ancha, FM estrecha y AM**, demodulada en el servidor y reproducida en el navegador.
- **Mis bandas** y **Mis frecuencias**: guarda rangos y canales con nombre, modo y nota.
- **Escaneo de mis frecuencias**: salta entre las marcadas, se queda en las que transmiten más de 2 s
  y vuelve a saltar cuando dejan de oírse.
- **Simulador** de `rtl_tcp` incluido para probarlo todo sin hardware.

## Capturas

| Escuchando una emisora (FM ancha) | Escaneando mis frecuencias |
|---|---|
| <img src="docs/capturas/escuchando-fm.png" alt="Escuchando 97,3 MHz en FM ancha"> | <img src="docs/capturas/escaneo-mis-frecuencias.png" alt="Escaneo de mis frecuencias fijado en una señal de banda aérea"> |

| PMR446 en modo monitor con cascada |
|---|
| <img src="docs/capturas/pmr446-cascada.png" alt="Canales PMR446 con transmisiones intermitentes en la cascada"> |

<sub>Capturas hechas con el simulador incluido (`npm run demo`) y datos de ejemplo.</sub>

## Cómo funciona

```
RTL-SDR ──USB── rtl_tcp.exe ──TCP:1234── server.js (FFT, barrido, demodulación) ──WebSocket── navegador
```

## Requisitos

- Node.js 18 o superior.
- Drivers del RTL-SDR en Windows: instala el driver **WinUSB** con [Zadig](https://zadig.akeo.ie/)
  sobre "Bulk-In, Interface (Interface 0)".
- `rtl_tcp.exe` de 64 bits: descarga `Release.zip` de [rtl-sdr-blog](https://github.com/rtlsdrblog/rtl-sdr-blog/releases)
  y copia el contenido de `x64\` (exe + dll) en `tools\rtl-sdr-x64\` (ya ignorado por git).
  Ojo: el `rtl_tcp.exe` de `C:\SDRSharp\bin` no arranca (error 0xC000007B) porque mezcla un exe de 64 bits
  con `rtlsdr.dll` de 32 bits.

## Uso

```bash
npm install
```

Con el dongle: en una terminal arranca rtl_tcp y en otra el servidor.

```bash
npm run rtl
```

```bash
npm start
```

Abre http://localhost:8080 y pulsa **Escanear**.

Sin dongle (simulador con emisoras FM, banda aérea, PMR446, ISM 433, ADS-B…):

```bash
npm run demo
```

Opciones del servidor: `--rtl host:puerto` (rtl_tcp en otra máquina, p. ej. una Raspberry Pi),
`--port 8080` (puerto web), `--sim`.

## Cómo usarlo

- **Banda**: preajustes del plan de bandas (FM, aérea, PMR446, ISM 433/868, ADS-B…), o escribe inicio/fin.
  Al elegir una banda, la frecuencia de escucha pasa al centro de la banda con su modo típico
  (o el que guardaste en una banda propia); si ya estabas escuchando, se resintoniza.
- **Mis bandas**: ajusta el rango (escribiéndolo o con zoom) y pulsa **＋ Guardar banda**; ponle nombre, color
  y, si quieres, el modo de escucha (se usará al pulsar 🎧 en señales de esa banda). Aparecen arriba del
  desplegable con ★, se dibujan sobre el espectro y se guardan en `data/bandas.json`. Para borrar una,
  selecciónala y pulsa **🗑 Borrar**.
- **Etiquetas**: en la tabla de señales, clic en la columna **Etiqueta** (aparece «＋ etiqueta» al pasar el ratón),
  escribe un nombre, elige color y pulsa Enter. Para quitarla, borra el nombre y Enter; Esc cancela.
  La etiqueta se dibuja sobre el espectro, sale al pasar el ratón y en el CSV, y vuelve a aparecer cada vez
  que se detecta esa señal, aunque limpies la lista. Se guardan en `data/etiquetas.json`.
  «Etiquetadas primero» en el orden de la tabla las agrupa arriba. Con el ratón sobre la tabla, las filas
  no se reordenan solas.
- **Mis frecuencias**: tus canales favoritos, con nombre, modo, ancho y una nota opcional.
  Para guardar una, sintonízala y pulsa **★ Guardar frecuencia** (panel Escuchar), o pulsa ☆ en una fila
  de la tabla de señales (si la señal tiene etiqueta, se propone ese nombre). Clic en una frecuencia de la
  lista para escucharla; ✎ para editarla y ✕ para borrarla. Con 6 o más aparece un buscador. Se marcan
  con ★ en el eje del espectro y se guardan en `data/frecuencias.json`.
- **Escanear mis frecuencias**: marca ☑ las que quieras vigilar y pulsa **⟳ Escanear mis frecuencias**.
  Salta de una a otra; si en una hay señal por encima del «Umbral sobre el ruido» se queda
  **confirmando** y, si dura más de *Confirmar tras* (2 s por defecto), sigue **escuchando**. Cuando lleva
  *Volver tras silencio* (2 s) sin señal, continúa con la siguiente. Las ráfagas cortas (mandos, sensores)
  se descartan solas. «Silenciar hasta confirmar» evita oír esas ráfagas; **⏭ Saltar** ignora la actual
  30 s. Las frecuencias cercanas (dentro de ~±0,9 MHz) se comprueban a la vez sin resintonizar.
  Cada salto tarda lo que *Asentar* + ~10 ms: con 120 ms son unos 7 saltos por segundo.
- **Zoom**: arrastra sobre el espectro o la cascada; doble clic acerca ×4; «Atrás» vuelve.
- Si el rango cabe en un solo salto (≈1,8 MHz a 2,4 MS/s) pasa a **modo monitor**: no resintoniza y
  actualiza ~30 veces por segundo.
- **Señales detectadas**: todo lo que supera el umbral (línea roja discontinua = ruido local + umbral).
  Clic en una fila para hacer zoom. Se guardan en el navegador y se exportan a CSV.

### Escuchar (FM / AM)

- Pon la frecuencia y el modo en el panel **Escuchar** y pulsa 🎧, o pulsa 🎧 en una fila de la tabla
  (elige el modo según la banda: FM radiodifusión → FM ancha, banda aérea → AM, resto → FM estrecha).
- Con la escucha activa, un **clic en el espectro** cambia de frecuencia (se ajusta al centro de la señal
  detectada más cercana). Dentro de los ~±1 MHz capturados el cambio es instantáneo, sin resintonizar.
- Modos: **FM ancha** (radio comercial, de-énfasis 50 µs europeo), **FM estrecha** (walkies, PMR446,
  radioaficionados, marina) y **AM** (banda aérea, CB). El *ancho de canal* solo aplica a FM estrecha y AM.
- **Silenciador (squelch)**: corta el audio cuando el nivel del canal (barra de colores) está por debajo de la marca.
- Mientras escuchas, el barrido se pausa (solo hay un sintonizador) y el espectro muestra la zona sintonizada.
  «Escanear» deja de escuchar y vuelve al barrido.
- El audio se demodula en el servidor y llega a la web por WebSocket; el navegador solo lo reproduce.

### Ajustes del receptor

| Ajuste | Qué hace |
|---|---|
| Ganancia | Manual por defecto (40 dB). En «Auto» el R820T suele saturarse: el ruido sube a ~-35 dBFS y desaparecen las señales. Lo mismo a 49,6 dB. Si ves señales «espejo» o el ruido sube en toda la banda, baja la ganancia. |
| Muestreo | Ancho capturado por salto. 2,4 MS/s es lo más estable. |
| FFT | Resolución: 1024 a 2,4 MS/s ≈ 2,3 kHz/bin. Para barrer todo el rango usa 256–512. |
| Promedios | Más promedios = ruido más liso y señales débiles más visibles, pero más lento. |
| Asentar | Tiempo que se descarta tras cada resintonía. **Si aparecen señales fantasma desplazadas exactamente un salto, súbelo** (100–150 ms con hardware real). |
| Ancho útil | Fracción central de cada captura que se usa (los bordes caen por el filtro). |
| ppm | Corrección del cristal del dongle. |
| Bias-T | Alimenta una antena/LNA activa (RTL-SDR Blog v3/v4). |
