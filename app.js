const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const socketIO = require('socket.io');
const wppconnect = require('@wppconnect-team/wppconnect');
const puppeteer = require('puppeteer'); // ✅ NUEVO
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data', 'clientes.json');
const API_KEY = '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';

let clientInstance = null;
let botActivo = false;
const usuariosSaludados = new Set();

function cargarClientes() {
    if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]');
    return JSON.parse(fs.readFileSync(DB_PATH));
}

function guardarClientes(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function detectarIntencionConIA(texto) {
    const prompt = `Quiero que analices el siguiente mensaje de WhatsApp de un usuario que quiere información sobre Canva Premium.

Tu tarea es identificar su intención exacta. Devuélveme solamente una de estas etiquetas (en minúsculas, sin explicación):

- info_campaña
- enviar_correo
- confirmar_activacion
- preguntar_pago
- confirmar_pago
- otro

Mensaje: """${texto}"""`;

    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'openai/gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
            },
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        return response.data.choices[0].message.content.trim().toLowerCase();
    } catch (error) {
        console.error('❌ Error con OpenRouter:', error.message);
        return 'otro';
    }
}

io.on('connection', (socket) => {
    console.log('🟢 Cliente conectado al panel');
    socket.emit('bot_estado', botActivo ? 'conectado' : 'desconectado');

    socket.on('iniciar_bot', async () => {
        if (botActivo || clientInstance) {
            socket.emit('bot_estado', 'conectado');
            return;
        }

        socket.on('detener_bot', async () => {
            if (clientInstance) {
                await clientInstance.close();
                clientInstance = null;
                botActivo = false;
                console.log('🔴 Bot apagado manualmente');
                io.emit('bot_estado', 'apagado');
            }
        });

        wppconnect
            .create({
                session: 'default',
                browserArgs: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ],
                executablePath: puppeteer.executablePath(), // ✅ Uso de Chromium embebido
                catchQR: (qr) => {
                    console.log('QR recibido en catchQR:', qr.slice(0, 100));
                    if (qr.startsWith('data:image')) {
                        io.emit('qr', qr);
                    } else {
                        const qrImage = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
                            qr
                        )}&size=250x250`;
                        io.emit('qr', qrImage);
                    }
                },
            })
            .then((client) => {
                clientInstance = client;
                botActivo = true;
                io.emit('bot_estado', 'conectado');
                io.emit('listo');
                console.log('✅ Bot conectado desde el botón');

                client.onMessage(async (message) => {
                    if (!message.isGroupMsg) {
                        const texto = message.body?.trim() || '';
                        const numero = message.from;
                        let intencion = 'otro';

                        if (message.type === 'image') {
                            intencion = 'confirmar_pago';
                        } else {
                            intencion = await detectarIntencionConIA(texto);
                        }

                        switch (intencion) {
                            case 'info_campaña':
                                if (usuariosSaludados.has(numero)) return;
                                usuariosSaludados.add(numero);

                                await client.sendText(
                                    numero,
                                    `👋 ¡Hola! Qué bueno tenerte por aquí.\n\n¿Usas Canva? Hoy te tengo una oportunidad increíble 🎯\n\nPor solo *$5.000 COP al año* puedes tener acceso a *Canva PRO* con:\n\n✨ Plantillas premium\n🪄 Quitar fondo de imágenes\n📐 Redimensionar diseños\n📱 Mockups profesionales\n🔓 Y muchas funciones más\n\n✅ *Activación inmediata* con tu mismo correo de Canva\n💸 *Pagas solo cuando confirmes que todo funciona*\n\n*Envíame tu correo de Canva y lo activamos AHORA mismo* 🙌🏼`
                                );

                                setTimeout(() => {
                                    usuariosSaludados.delete(numero);
                                }, 60 * 1000);
                                break;

                            case 'enviar_correo': {
                                const clientes = cargarClientes();
                                const clienteExistente = clientes.find((c) => c.numero === numero);

                                if (!clienteExistente) {
                                    const nuevoCliente = {
                                        numero,
                                        correo: texto,
                                        estado: 'pendiente',
                                        fecha: new Date().toISOString(),
                                    };
                                    clientes.push(nuevoCliente);
                                    guardarClientes(clientes);
                                    io.emit('nuevo_cliente', nuevoCliente);

                                    await client.sendText(
                                        numero,
                                        '⏳ ¡Gracias por enviar tu correo!\n\nEstamos preparando tu activación y en unos minutos recibirás la invitación. Te avisaré apenas esté lista 📩✨'
                                    );
                                } else if (clienteExistente.estado === 'pendiente') {
                                    await client.sendText(numero, '⏳ Tu activación está pendiente, pronto te avisaremos.');
                                } else if (clienteExistente.estado === 'activado') {
                                    await client.sendText(numero, '✅ Ya tienes la cuenta activada.');
                                }
                                break;
                            }

                            case 'confirmar_activacion':
                            case 'preguntar_pago':
                                await client.sendText(
                                    numero,
                                    `💳 ¡Perfecto! Puedes realizar tu pago así:\n\n📲 *NEQUI:* 310 531 3941\n👤 A nombre de: *Algemiro Terán*\n💰 Valor: *$5.000 COP*\n\nUna vez hagas la transferencia, envíame una captura para confirmar y dejar todo listo ✅`
                                );
                                break;

                            case 'confirmar_pago': {
                                const clientes = cargarClientes();
                                const clienteIndex = clientes.findIndex((c) => c.numero === numero);
                                if (clienteIndex !== -1) {
                                    clientes[clienteIndex].estado = 'vendido';
                                    guardarClientes(clientes);
                                    io.emit('actualizar_estado', { numero, estado: 'vendido' });
                                }

                                await client.sendText(
                                    numero,
                                    `✅ ¡Listo! Ya tienes acceso completo a Canva PRO 🎉\n\nDisfruta todas las funciones premium: quitar fondo, redimensionar, plantillas y más.\n\nSi tienes algún familiar o amigo que necesite Canva PRO, recomiéndanos ❤`
                                );

                                setTimeout(() => {
                                    client.sendText(
                                        numero,
                                        `😊 ¡Un gusto asesorarte hoy! Si necesitas algo más, estaré siempre disponible. ¡Éxitos con tus diseños! 🎨🚀`
                                    );
                                }, 3000);
                                break;
                            }

                            default:
                                console.log(`🔕 Mensaje sin intención clara: ${texto}`);
                                break;
                        }
                    }
                });
            })
            .catch((err) => {
                console.error('❌ Error al iniciar el bot:', err.message);
            });
    });
});

app.get('/api/clientes', (req, res) => {
    const clientes = cargarClientes();
    res.json(clientes);
});

app.post('/api/estado', async (req, res) => {
    const { numero, estado } = req.body;
    let clientes = cargarClientes();
    clientes = clientes.map((c) => (c.numero === numero ? { ...c, estado } : c));
    guardarClientes(clientes);
    io.emit('actualizar_estado', { numero, estado });

    if (estado === 'activado' && clientInstance) {
        await clientInstance.sendText(
            numero,
            `✅ *¡Listo! Tu cuenta Canva PRO ya está activada*\n\n📩 Revisa tu correo AHORA y acepta la invitación para disfrutar todos los beneficios.\n\n🚀 *Verifica:*\n🪄 Quitar fondos\n📐 Redimensionar\n🎨 Plantillas\n📱 Mockups\n\n⏰ Tienes 30 minutos para confirmar que todo funciona.`
        );
    }

    res.json({ ok: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bot.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
