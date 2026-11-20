// Codekoje-Werkstatt – Python-Worker (Pyodide)
// Läuft getrennt von der Oberfläche. Führt Projekte aus, fragt input() live ab,
// lässt sich per Stopp-Knopf unterbrechen, vervollständigt Code (Jedi) und simuliert einen Raspberry Pi.

const VERSIONEN = ["0.28.0", "0.27.7", "0.27.5"]; // erste funktionierende wird genommen
const BASIS = "/home/pyodide/projekte";
const SIM = "/home/pyodide/sim";

let pyodide = null, pyodideVersion = null;
let sab = null;              // geteilte Speicher (nur wenn die Seite "cross-origin isolated" ist)
let ctrl, ein, intr, sens, schlafArr;
let stdinFallback = [];
let fallbackWerte = { sensoren: {}, pins: {} };
let sensorIndex = {};
let installiert = new Set();
let jediGeladen = false;
let gesendet = {};           // Dateien, wie sie vor dem Lauf geschickt wurden

const dec = new TextDecoder();

function sende(typ, daten, transfer) { postMessage(Object.assign({ typ }, daten || {}), transfer || []); }

/* ---------- Ausgabe gebündelt senden ---------- */
let puffer = { out: "", err: "" }, zuletzt = 0;
function raus(kanal, text) {
  puffer[kanal] += text;
  const jetzt = Date.now();
  if (puffer.out.length + puffer.err.length > 4000 || jetzt - zuletzt > 40) flush();
}
function flush() {
  zuletzt = Date.now();
  if (puffer.err) { sende("err", { text: puffer.err }); puffer.err = ""; }
  if (puffer.out) { sende("out", { text: puffer.out }); puffer.out = ""; }
}
const decOut = new TextDecoder(), decErr = new TextDecoder();

/* ---------- Raspberry-Pi-Simulator (Python-Module) ---------- */
const SIM_DATEIEN = {
"pisim.py": String.raw`"""Pykoje Pi-Simulator – Kern.
pisim.name(17, "Pumpe")    -> Anzeigename im Pi-Tab
pisim.sensor("temperatur") -> Wert des Schiebereglers
Sensoren: temperatur, luftfeuchte, boden1, boden2, wassertemp, licht, co2, wasserstand
"""
import json as _json
import pykoje_js as _js

_pins = {}
_namen = {}
_beobachter = []

def _ev(**k):
    _js.pi(_json.dumps(k))

def _nr(pin):
    if hasattr(pin, "id"):
        pin = pin.id
    if isinstance(pin, str):
        p = pin.upper().replace("GPIO", "").replace("BCM", "").strip()
        return int(p)
    return int(pin)

def name(pin, text):
    pin = _nr(pin)
    _namen[pin] = text
    _ev(art="name", pin=pin, name=text)

def setup(pin, modus, name=None, pull=None):
    pin = _nr(pin)
    _pins[pin] = {"modus": modus, "wert": 0, "pull": pull}
    _ev(art="setup", pin=pin, modus=modus, name=name or _namen.get(pin), pull=pull)

def schreibe(pin, wert):
    pin = _nr(pin)
    if pin not in _pins:
        setup(pin, "out")
    _pins[pin]["wert"] = wert
    _ev(art="out", pin=pin, wert=float(wert))

def gedrueckt(pin):
    pin = _nr(pin)
    if pin not in _pins:
        setup(pin, "in")
    return bool(_js.pin(pin))

def pegel(pin):
    pin = _nr(pin)
    an = gedrueckt(pin)
    if _pins[pin].get("pull") == "up":
        return 0 if an else 1
    return 1 if an else 0

def sensor(name):
    return float(_js.sensor(name))

_dht = {"n": 0}

def dht_messung():
    """Wie beim echten DHT22: wenn eingeschaltet, schlägt jede 4. Messung fehl."""
    _dht["n"] += 1
    if sensor("_dhtfehler") and _dht["n"] % 4 == 0:
        raise RuntimeError("Checksum did not validate. Try again.")

def reset():
    _dht["n"] = 0
    _pins.clear()
    _beobachter.clear()
    _ev(art="reset")

def beobachte(f):
    _beobachter.append(f)

def _tick():
    for f in list(_beobachter):
        try:
            f()
        except Exception:
            import traceback
            traceback.print_exc()

def pause():
    """Wartet endlos und reagiert dabei auf Knöpfe (wie signal.pause())."""
    import time
    while True:
        time.sleep(0.05)
`,
"RPi/__init__.py": "",
"RPi/GPIO.py": String.raw`"""Simuliertes RPi.GPIO für die Pykoje."""
import time as _time
import pisim as _p

BCM = 11; BOARD = 10
OUT = 0; IN = 1
HIGH = 1; LOW = 0
PUD_OFF = 20; PUD_DOWN = 21; PUD_UP = 22
RISING = 31; FALLING = 32; BOTH = 33
VERSION = "pykoje-sim"
RPI_INFO = {"TYPE": "Pi (simuliert)"}
_modus = None
_flanken = {}

def setmode(m):
    global _modus
    _modus = m

def getmode():
    return _modus

def setwarnings(f):
    pass

def _liste(x):
    return list(x) if isinstance(x, (list, tuple)) else [x]

def setup(channel, direction, pull_up_down=PUD_OFF, initial=None):
    for c in _liste(channel):
        if direction == OUT:
            _p.setup(c, "out")
            if initial is not None:
                _p.schreibe(c, 1 if initial else 0)
        else:
            _p.setup(c, "in", pull={PUD_UP: "up", PUD_DOWN: "down"}.get(pull_up_down))

def output(channel, value):
    chs = _liste(channel)
    vals = _liste(value) if isinstance(value, (list, tuple)) else [value] * len(chs)
    for c, v in zip(chs, vals):
        _p.schreibe(c, 1 if v else 0)

def input(channel):
    return _p.pegel(channel)

def cleanup(channel=None):
    _p.reset()
    _flanken.clear()

def gpio_function(channel):
    return OUT if _p._pins.get(channel, {}).get("modus") == "out" else IN

class PWM:
    def __init__(self, channel, frequency):
        self.channel = channel
        self.frequency = frequency
        self.dc = 0
        _p.setup(channel, "pwm")
    def start(self, dutycycle):
        self.dc = dutycycle
        _p.schreibe(self.channel, dutycycle / 100.0)
    def ChangeDutyCycle(self, dutycycle):
        self.start(dutycycle)
    def ChangeFrequency(self, frequency):
        self.frequency = frequency
    def stop(self):
        _p.schreibe(self.channel, 0)

def add_event_detect(channel, edge, callback=None, bouncetime=None):
    _flanken[channel] = {"edge": edge, "alt": input(channel), "cbs": [callback] if callback else [], "erkannt": False}
    def pruefe(ch=channel):
        f = _flanken.get(ch)
        if not f:
            return
        neu = input(ch)
        if neu != f["alt"]:
            steigend = neu == 1
            if f["edge"] == BOTH or (f["edge"] == RISING and steigend) or (f["edge"] == FALLING and not steigend):
                f["erkannt"] = True
                for cb in f["cbs"]:
                    cb(ch)
            f["alt"] = neu
    _p.beobachte(pruefe)

def add_event_callback(channel, callback):
    _flanken[channel]["cbs"].append(callback)

def remove_event_detect(channel):
    _flanken.pop(channel, None)

def event_detected(channel):
    f = _flanken.get(channel)
    if f and f["erkannt"]:
        f["erkannt"] = False
        return True
    return False

def wait_for_edge(channel, edge, timeout=None, bouncetime=None):
    alt = input(channel)
    start = _time.monotonic()
    while True:
        neu = input(channel)
        if neu != alt:
            if edge == BOTH or (edge == RISING and neu == 1) or (edge == FALLING and neu == 0):
                return channel
            alt = neu
        if timeout is not None and (_time.monotonic() - start) * 1000 >= timeout:
            return None
        _time.sleep(0.02)
`,
"gpiozero.py": String.raw`"""Simuliertes gpiozero für die Pykoje (die wichtigsten Bauteile)."""
import time as _time
import pisim as _p

class GPIOZeroError(Exception):
    pass

class Device:
    def close(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *a):
        self.close()

class OutputDevice(Device):
    _modus = "out"
    def __init__(self, pin=None, *, active_high=True, initial_value=False, name=None, pin_factory=None, **k):
        self.pin = _p._nr(pin)
        self.active_high = active_high
        self._wert = 0
        _p.setup(self.pin, self._modus, name=name or type(self).__name__)
        self.value = initial_value or 0
    @property
    def value(self):
        return self._wert
    @value.setter
    def value(self, v):
        self._wert = float(v) if self._modus == "pwm" else (1 if v else 0)
        _p.schreibe(self.pin, self._wert)
    def on(self):
        self.value = 1
    def off(self):
        self.value = 0
    def toggle(self):
        self.value = 0 if self.value else 1
    @property
    def is_active(self):
        return bool(self.value)
    is_lit = is_active
    def blink(self, on_time=1, off_time=1, n=None, background=True, **k):
        # Im Browser gibt es keine Hintergrund-Threads: blinkt direkt (Standard 3x)
        for _ in range(n or 3):
            self.on(); _time.sleep(on_time)
            self.off(); _time.sleep(off_time)

class DigitalOutputDevice(OutputDevice): pass
class LED(DigitalOutputDevice): pass
class Buzzer(DigitalOutputDevice): pass

class PWMOutputDevice(OutputDevice):
    _modus = "pwm"
    def pulse(self, fade_in_time=1, fade_out_time=1, n=None, background=True):
        for _ in range(n or 2):
            for i in range(21):
                self.value = i / 20; _time.sleep(fade_in_time / 20)
            for i in range(20, -1, -1):
                self.value = i / 20; _time.sleep(fade_out_time / 20)

class PWMLED(PWMOutputDevice): pass

class Motor(Device):
    def __init__(self, forward, backward=None, *, pwm=True, name=None, **k):
        self.v = PWMOutputDevice(forward, name=(name or "Motor") + " vor")
        self.r = PWMOutputDevice(backward, name=(name or "Motor") + " zurück") if backward is not None else None
    def forward(self, speed=1):
        self.v.value = speed
        if self.r: self.r.value = 0
    def backward(self, speed=1):
        self.v.value = 0
        if self.r: self.r.value = speed
    def stop(self):
        self.v.value = 0
        if self.r: self.r.value = 0
    @property
    def value(self):
        return self.v.value - (self.r.value if self.r else 0)

class InputDevice(Device):
    def __init__(self, pin=None, *, pull_up=False, name=None, **k):
        self.pin = _p._nr(pin)
        _p.setup(self.pin, "in", name=name or type(self).__name__, pull="up" if pull_up else "down")
    @property
    def value(self):
        return 1 if _p.gedrueckt(self.pin) else 0
    @property
    def is_active(self):
        return bool(self.value)

class DigitalInputDevice(InputDevice): pass

class Button(DigitalInputDevice):
    def __init__(self, pin=None, *, pull_up=True, bounce_time=None, hold_time=1, name=None, **k):
        super().__init__(pin, pull_up=pull_up, name=name or "Button")
        self.when_pressed = None
        self.when_released = None
        self._alt = self.is_pressed
        _p.beobachte(self._pruefe)
    @property
    def is_pressed(self):
        return _p.gedrueckt(self.pin)
    def _pruefe(self):
        neu = self.is_pressed
        if neu != self._alt:
            self._alt = neu
            cb = self.when_pressed if neu else self.when_released
            if cb:
                try:
                    cb(self)
                except TypeError:
                    cb()
    def wait_for_press(self, timeout=None):
        return self._warte(True, timeout)
    def wait_for_release(self, timeout=None):
        return self._warte(False, timeout)
    def _warte(self, ziel, timeout):
        start = _time.monotonic()
        while self.is_pressed != ziel:
            if timeout is not None and _time.monotonic() - start > timeout:
                return False
            _time.sleep(0.02)
        return True

class MotionSensor(Button):
    def __init__(self, pin=None, **k):
        k.setdefault("pull_up", False)
        k.setdefault("name", "Bewegungsmelder")
        super().__init__(pin, **k)
    @property
    def motion_detected(self):
        return self.is_pressed
    def wait_for_motion(self, timeout=None):
        return self.wait_for_press(timeout)

class MCP3008(Device):
    """Analog-Digital-Wandler. Kanal 0/1 = Bodenfeuchte, 2 = Licht, 3 = Wasserstand."""
    _kanal = {0: ("boden1", 100), 1: ("boden2", 100), 2: ("licht", 20000), 3: ("wasserstand", 100)}
    def __init__(self, channel=0, **k):
        self.channel = channel
    @property
    def value(self):
        n, m = self._kanal.get(self.channel, ("boden1", 100))
        return max(0.0, min(1.0, _p.sensor(n) / m))
    @property
    def voltage(self):
        return self.value * 3.3

class MCP3004(MCP3008): pass

class CPUTemperature(Device):
    def __init__(self, **k):
        pass
    @property
    def temperature(self):
        return 47.5

def pause():
    _p.pause()
`,
"board.py": String.raw`"""Simuliertes board-Modul (Adafruit Blinka)."""
class Pin:
    def __init__(self, n):
        self.id = n
    def __index__(self):
        return self.id
    def __int__(self):
        return self.id
    def __repr__(self):
        return "board.D" + str(self.id)
for _i in range(28):
    globals()["D%d" % _i] = Pin(_i)
SDA = D2; SCL = D3
class _I2C:
    pass
def I2C():
    return _I2C()
`,
"adafruit_dht.py": String.raw`"""Simulierter DHT11/DHT22 (Temperatur + Luftfeuchte)."""
import pisim as _p

class _DHT:
    def __init__(self, pin=None, use_pulseio=True):
        self.pin = pin
        self._nr = _p._nr(pin) if pin is not None else 4
        _p._ev(art="dht", pin=self._nr)
    @property
    def temperature(self):
        try:
            _p.dht_messung()
        except RuntimeError:
            _p._ev(art="dht", pin=self._nr, fehler=True)
            raise
        t = round(_p.sensor("temperatur"), 1)
        _p._ev(art="dht", pin=self._nr, t=t, h=round(_p.sensor("luftfeuchte"), 1))
        return t
    @property
    def humidity(self):
        return round(_p.sensor("luftfeuchte"), 1)
    def measure(self):
        pass
    def exit(self):
        pass

class DHT22(_DHT): pass
class DHT11(_DHT): pass
class DHT21(_DHT): pass
`,
"w1thermsensor.py": String.raw`"""Simulierter DS18B20 (Wassertemperatur)."""
import pisim as _p

class Unit:
    DEGREES_C = "celsius"; DEGREES_F = "fahrenheit"; KELVIN = "kelvin"

class Sensor:
    DS18B20 = "DS18B20"

class W1ThermSensor:
    def __init__(self, sensor_type=None, sensor_id=None, **k):
        self.id = sensor_id or "28-pykoje000001"
    def get_temperature(self, unit=Unit.DEGREES_C):
        c = _p.sensor("wassertemp")
        if unit == Unit.DEGREES_F:
            return c * 9 / 5 + 32
        if unit == Unit.KELVIN:
            return c + 273.15
        return c
    @classmethod
    def get_available_sensors(cls, types=None):
        return [cls()]
`,
};

/* ---------- Python-Hilfsfunktionen ---------- */
const PY_HILFE = String.raw`
import sys, os, json, traceback, time as _time
import pykoje_js as _pk_js

os.environ["MPLBACKEND"] = "Agg"
_PK_BASIS = "/home/pyodide/projekte"
_pk_ns = {"__name__": "__main__"}

# time.sleep: schlafen ohne Prozessor zu verbraten, dabei Knöpfe des Pi-Simulators abfragen
_pk_orig_sleep = _time.sleep
def _pk_sleep(s):
    ende = _time.monotonic() + max(0.0, float(s))
    while True:
        rest = ende - _time.monotonic()
        if rest <= 0:
            break
        st = min(rest, 0.05)
        if not _pk_js.schlaf(st):
            _pk_orig_sleep(st)
        if "pisim" in sys.modules:
            sys.modules["pisim"]._tick()
_time.sleep = _pk_sleep

import signal as _signal
def _pk_pause():
    while True:
        _time.sleep(0.05)
_signal.pause = _pk_pause

def _pk_patch_mpl():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    if getattr(plt, "_pykoje", False):
        return
    import io, base64
    def show(*a, **k):
        for n in plt.get_fignums():
            fig = plt.figure(n)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
            _pk_js.bild(base64.b64encode(buf.getvalue()).decode())
        plt.close("all")
    plt.show = show
    plt._pykoje = True

def _pk_mpl_rest():
    m = sys.modules.get("matplotlib.pyplot")
    if m is not None and m.get_fignums():
        m.show()

def _pk_fehler(e, projdir):
    if isinstance(e, KeyboardInterrupt):
        return json.dumps({"text": "⏹ Abgebrochen.\n", "datei": None, "zeile": None, "art": "KeyboardInterrupt"})
    te = traceback.TracebackException.from_exception(e)
    eigene = [f for f in te.stack if f.filename.startswith(projdir + "/") or f.filename == "<konsole>"]
    te.stack = traceback.StackSummary.from_list(eigene)
    text = "".join(te.format()).replace(projdir + "/", "")
    datei = zeile = None
    if isinstance(e, SyntaxError) and e.filename and str(e.filename).startswith(projdir + "/"):
        datei = str(e.filename).replace(projdir + "/", ""); zeile = e.lineno
    elif eigene and eigene[-1].filename != "<konsole>":
        datei = eigene[-1].filename.replace(projdir + "/", ""); zeile = eigene[-1].lineno
    return json.dumps({"text": text, "datei": datei, "zeile": zeile, "art": type(e).__name__})

def _pk_vorbereiten(projdir, mpl):
    os.chdir(projdir)
    for p in list(sys.path):
        if p.startswith(_PK_BASIS):
            sys.path.remove(p)
    sys.path.insert(0, projdir)
    for n, m in list(sys.modules.items()):
        f = getattr(m, "__file__", None) or ""
        if f.startswith(_PK_BASIS):
            del sys.modules[n]
    if "pisim" in sys.modules:
        sys.modules["pisim"].reset()
    if mpl:
        _pk_patch_mpl()

def _pk_run(path, projdir, mpl):
    global _pk_ns
    _pk_vorbereiten(projdir, mpl)
    _pk_ns = {"__name__": "__main__", "__file__": path, "__builtins__": __builtins__}
    try:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        exec(compile(src, path, "exec"), _pk_ns)
        _pk_mpl_rest()
        return ""
    except SystemExit:
        return ""
    except BaseException as e:
        return _pk_fehler(e, projdir)
    finally:
        sys.stdout.flush(); sys.stderr.flush()

def _pk_konsole(code, projdir, mpl):
    if mpl:
        _pk_patch_mpl()
    try:
        os.chdir(projdir)
        if projdir not in sys.path:
            sys.path.insert(0, projdir)
        exec(compile(code, "<konsole>", "single"), _pk_ns)
        _pk_mpl_rest()
        return ""
    except SystemExit:
        return ""
    except BaseException as e:
        return _pk_fehler(e, projdir)
    finally:
        sys.stdout.flush(); sys.stderr.flush()

def _pk_check(src, path):
    try:
        compile(src, path, "exec")
        return ""
    except SyntaxError as e:
        return json.dumps({"zeile": e.lineno, "spalte": e.offset, "msg": e.msg})
    except Exception:
        return ""

def _pk_complete(src, line, col, path):
    import jedi
    try:
        s = jedi.Script(src, path=path)
        out = [{"t": c.name, "y": c.type} for c in s.complete(line, col)[:80] if not c.name.startswith("__")]
        return json.dumps(out)
    except Exception:
        return "[]"

def _pk_installiert():
    import importlib.metadata as md
    return "\n".join(sorted({f"{d.metadata['Name']}=={d.version}" for d in md.distributions() if d.metadata['Name']}, key=str.lower))
`;

/* ---------- Start ---------- */
async function ladePyodide() {
  let letzterFehler = null;
  for (const v of VERSIONEN) {
    const basis = `https://cdn.jsdelivr.net/pyodide/v${v}/full/`;
    try {
      importScripts(basis + "pyodide.js");
      pyodide = await loadPyodide({ indexURL: basis });
      pyodideVersion = v;
      return;
    } catch (e) { letzterFehler = e; }
  }
  throw letzterFehler || new Error("Pyodide konnte nicht geladen werden");
}

function stdinLesen() {
  flush();
  if (sab) {
    Atomics.store(ctrl, 0, 0);
    sende("eingabe", {});
    while (Atomics.load(ctrl, 0) === 0) {
      Atomics.wait(ctrl, 0, 0, 100);
      if (intr[0] === 2) return null; // Stopp gedrückt
    }
    const n = ctrl[1];
    const text = dec.decode(ein.slice(0, n));
    Atomics.store(ctrl, 0, 0);
    return text + "\n";
  }
  if (stdinFallback.length) return stdinFallback.shift() + "\n";
  raus("err", "[input(): keine Eingabe vorhanden – trag Antworten im Tab 'Eingaben' ein]\n");
  return null;
}

async function start(m) {
  sende("status", { text: "Python wird geladen …" });
  if (m.sab) {
    sab = m.sab;
    ctrl = new Int32Array(sab.ctrl);
    ein = new Uint8Array(sab.daten);
    intr = new Uint8Array(sab.intr);
    sens = new Float64Array(sab.sensor);
    schlafArr = new Int32Array(sab.schlaf);
  }
  (m.sensorNamen || []).forEach((n, i) => sensorIndex[n] = i);
  await ladePyodide();

  if (sab) pyodide.setInterruptBuffer(intr);
  pyodide.setStdout({ write: (b) => { raus("out", decOut.decode(b, { stream: true })); return b.length; } });
  pyodide.setStderr({ write: (b) => { raus("err", decErr.decode(b, { stream: true })); return b.length; } });
  pyodide.setStdin({ stdin: stdinLesen });

  pyodide.registerJsModule("pykoje_js", {
    bild: (b64) => { flush(); sende("bild", { daten: b64 }); },
    pi: (json) => { flush(); sende("pi", { ev: JSON.parse(json) }); },
    sensor: (name) => {
      const i = sensorIndex[name];
      if (i === undefined) throw new Error("Unbekannter Sensor: " + name + " (verfügbar: " + Object.keys(sensorIndex).join(", ") + ")");
      return sab ? sens[i] : (fallbackWerte.sensoren[name] ?? 0);
    },
    pin: (pin) => sab ? (sens[32 + pin] ? 1 : 0) : (fallbackWerte.pins[pin] ? 1 : 0),
    schlaf: (sek) => {
      if (!sab) return false;
      Atomics.wait(schlafArr, 0, 0, Math.max(0, sek * 1000));
      return true;
    },
  });

  // Pi-Simulator-Module bereitlegen
  for (const [pfad, inhalt] of Object.entries(SIM_DATEIEN)) {
    const voll = SIM + "/" + pfad;
    pyodide.FS.mkdirTree(voll.substring(0, voll.lastIndexOf("/")));
    pyodide.FS.writeFile(voll, inhalt);
  }
  pyodide.FS.mkdirTree(BASIS);
  pyodide.runPython(`import sys\nsys.path.append("${SIM}")`);
  pyodide.runPython(PY_HILFE);

  sende("status", { text: "micropip wird geladen …" });
  await pyodide.loadPackage("micropip");

  const info = pyodide.runPython("import sys; sys.version.split()[0]");
  sende("bereit", { python: info, pyodide: pyodideVersion, live: !!sab });
}

/* ---------- Projektdateien ---------- */
function projDir(name) { return BASIS + "/" + name.replace(/[^\w\-. äöüÄÖÜß]/g, "_"); }

function rmrf(pfad) {
  const FS = pyodide.FS;
  let st;
  try { st = FS.stat(pfad); } catch (e) { return; }
  if (FS.isDir(st.mode)) {
    for (const n of FS.readdir(pfad)) if (n !== "." && n !== "..") rmrf(pfad + "/" + n);
    FS.rmdir(pfad);
  } else FS.unlink(pfad);
}

function schreibeProjekt(name, dateien) {
  const dir = projDir(name);
  rmrf(dir);
  pyodide.FS.mkdirTree(dir);
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    const voll = dir + "/" + pfad;
    pyodide.FS.mkdirTree(voll.substring(0, voll.lastIndexOf("/")));
    pyodide.FS.writeFile(voll, inhalt);
  }
  gesendet = dateien;
  return dir;
}

const TEXT_ENDUNGEN = /\.(py|txt|csv|tsv|json|md|html?|css|js|toml|cfg|ini|ya?ml|xml|log|sql|sh|gitignore)$/i;
function alsTextOderBytes(pfad, bytes) {
  if (TEXT_ENDUNGEN.test(pfad) || !bytes.includes(0)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { }
  }
  return bytes;
}

function gleich(a, b) {
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sammleAenderungen(dir) {
  const FS = pyodide.FS;
  const gefunden = {};
  (function lauf(p, rel) {
    for (const n of FS.readdir(p)) {
      if (n === "." || n === ".." || n === "__pycache__") continue;
      const voll = p + "/" + n, r = rel ? rel + "/" + n : n;
      const st = FS.stat(voll);
      if (FS.isDir(st.mode)) lauf(voll, r);
      else if (st.size <= 10 * 1024 * 1024) gefunden[r] = alsTextOderBytes(r, FS.readFile(voll));
    }
  })(dir, "");
  const geaendert = {}, geloescht = [];
  for (const [p, v] of Object.entries(gefunden)) if (!(p in gesendet) || !gleich(gesendet[p], v)) geaendert[p] = v;
  for (const p of Object.keys(gesendet)) if (!(p in gefunden)) geloescht.push(p);
  return { geaendert, geloescht };
}

/* ---------- Pakete ---------- */
async function installiere(namen, still) {
  const micropip = pyodide.pyimport("micropip");
  try {
    for (const n of namen) {
      if (!still) { raus("out", `📦 installiere ${n} …\n`); flush(); }
      await micropip.install(n, { keep_going: true });
      installiert.add(n.toLowerCase());
      if (!still) raus("out", `✔ ${n} installiert\n`);
    }
  } finally { micropip.destroy(); }
}

function anforderungen(dateien) {
  const t = dateien["requirements.txt"];
  if (typeof t !== "string") return [];
  return t.split("\n").map(z => z.replace(/#.*/, "").trim()).filter(z => z && !z.startsWith("-"));
}

async function vorbereiten(dateien) {
  const fehlend = anforderungen(dateien).filter(n => !installiert.has(n.toLowerCase()));
  for (const n of fehlend) {
    sende("status", { text: "installiere " + n + " …" });
    try { await installiere([n], false); }
    catch (e) { raus("err", `✘ ${n} aus requirements.txt ließ sich nicht installieren: ${kurz(e)}\n`); installiert.add(n.toLowerCase()); }
  }
  const alleCode = Object.entries(dateien).filter(([p, v]) => p.endsWith(".py") && typeof v === "string").map(([, v]) => v).join("\n");
  try {
    await pyodide.loadPackagesFromImports(alleCode, {
      messageCallback: (t) => sende("status", { text: t }),
      errorCallback: (t) => raus("err", t + "\n"),
    });
  } catch (e) { }
  flush();
  return /matplotlib|pylab|seaborn|pandas/.test(alleCode);
}

function kurz(e) {
  const s = String(e && e.message ? e.message : e).trim().split("\n");
  return s.slice(-3).join("\n");
}

/* ---------- Nachrichten ---------- */
onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.typ) {
      case "start":
        await start(m);
        break;

      case "run": {
        stdinFallback = (m.stdin || "").split("\n");
        if (stdinFallback.length && stdinFallback[stdinFallback.length - 1] === "") stdinFallback.pop();
        fallbackWerte = m.werte || fallbackWerte;
        if (intr) intr[0] = 0;
        const dir = schreibeProjekt(m.projekt, m.dateien);
        const mpl = await vorbereiten(m.dateien);
        sende("status", { text: "läuft …" });
        if (intr) intr[0] = 0;
        const fn = pyodide.globals.get(m.konsole ? "_pk_konsole" : "_pk_run");
        const erg = m.konsole ? fn(m.code, dir, mpl) : fn(dir + "/" + m.datei, dir, mpl);
        fn.destroy();
        flush();
        const aend = sammleAenderungen(dir);
        sende("fertig", { fehler: erg ? JSON.parse(erg) : null, aenderungen: aend });
        break;
      }

      case "install":
        await installiere([m.name], false);
        flush();
        sende("installiert", { name: m.name });
        break;

      case "liste":
        sende("liste", { text: pyodide.runPython("_pk_installiert()") });
        break;

      case "check": {
        const fn = pyodide.globals.get("_pk_check");
        const r = fn(m.code, m.pfad); fn.destroy();
        sende("check", { id: m.id, fehler: r ? JSON.parse(r) : null });
        break;
      }

      case "complete": {
        if (!jediGeladen) {
          sende("status", { text: "Vervollständigung wird geladen …" });
          await pyodide.loadPackage("jedi");
          jediGeladen = true;
          sende("status", { text: "bereit", ok: true });
        }
        const fn = pyodide.globals.get("_pk_complete");
        const r = fn(m.code, m.zeile, m.spalte, m.pfad); fn.destroy();
        sende("complete", { id: m.id, liste: JSON.parse(r) });
        break;
      }
    }
  } catch (e) {
    flush();
    const text = String(e && e.message ? e.message : e);
    if (m.typ === "install") {
      raus("err", `✘ ${m.name} ließ sich nicht installieren:\n${kurz(text)}\n` +
        "→ Meist heißt das: Das Paket enthält C-Code, für den es keine Browser-Version (WebAssembly) gibt.\n");
      flush();
      sende("installFehler", { name: m.name });
    } else if (m.typ === "start") {
      sende("err", { text: text + "\n" });
      sende("startFehler", {});
    } else if (m.typ === "complete") {
      sende("complete", { id: m.id, liste: [] });
    } else if (m.typ === "check") {
      sende("check", { id: m.id, fehler: null });
    } else {
      sende("err", { text: text.replace(/^PythonError: /, "") + "\n" });
      sende("fertig", { fehler: null, aenderungen: { geaendert: {}, geloescht: [] } });
    }
  }
};
