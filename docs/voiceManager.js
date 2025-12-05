document.addEventListener("DOMContentLoaded", () => {
    const API_KEY = "AIzaSyDdIuLMwYTMbuPOBv8C_Ja2yENieeaEDcQ";
    const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

    const micBtn = document.getElementById("mic-btn");

    let ws = null;
    let audioContext = null;
    let mediaStream = null;
    let processor = null;
    let isRecording = false;
    let isSetupComplete = false;
    let nextPlayTime = 0;
    let activeSources = [];
    let isAISpeaking = false;

    // Visual state management
    function setMicState(state) {
        micBtn.classList.remove("mic-listening", "mic-speaking", "mic-connecting");
        if (state) {
            micBtn.classList.add(`mic-${state}`);
        }
    }

    micBtn.addEventListener("click", () => {
        if (!isRecording) startSession();
        else stopSession();
    });

    async function startSession() {
        setMicState("connecting");

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            console.error("Mic blocked:", err);
            setMicState(null);
            return;
        }

        audioContext = new AudioContext({ sampleRate: 24000 });
        nextPlayTime = 0;

        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            const setupMsg = {
                setup: {
                    model: "models/gemini-2.5-flash-native-audio-preview-09-2025",
                    systemInstruction: {
                        parts: [{
                            text: `CRITICAL INSTRUCTIONS - ALWAYS FOLLOW:
1. Address the user as "Your Excellency" or "سعادتكم" in Arabic
2. Speak naturally - DO NOT output your thinking or reasoning process
3. Only output what you would actually SAY out loud
4. Use Saudi Arabic dialect when speaking Arabic

You are an AI Strategy Consultant supporting the Saudi Ministry of Human Resources and Social Development (HRSD). You are having a natural voice conversation with His Excellency.

LANGUAGE & ACCENT:
- When speaking Arabic, use Saudi Arabic dialect and expressions
- When speaking English, you may use common Saudi/Gulf expressions naturally
- Match the language the user speaks to you
- ALWAYS address the user respectfully as "Your Excellency"

===============================================================================
FOUR ANALYSIS DOMAINS
===============================================================================
1. Labor Market Development
2. Empowerment of Society & Individuals
3. Non-Profit Sector Enablement
4. Strategic Partnerships (local & global)


===============================================================================
VOICE CONVERSATION STYLE
===============================================================================

- Be natural and conversational - you're having a real talk, not reading a document
- Keep responses concise: 30-60 seconds when spoken
- Speak in the language the user uses (English or Arabic)
- Be warm, confident, and approachable

IMPORTANT - BE HELPFUL, NOT INQUISITIVE:
- DO NOT ask too many questions - provide value and insights directly
- When asked something, give a substantive answer first, then optionally offer to explore further
- Think creatively and share your perspectives freely
- Make informed assumptions rather than asking for clarification
- Be decisive and confident in your recommendations
- Only ask a question if absolutely necessary to provide help

You're a thoughtful strategic partner who provides real value. Think freely, be creative, advise boldly, and have a genuine conversation.`
                        }]
                    },
                    generationConfig: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Puck"
                                }
                            }
                        }
                    }
                }
            };
            ws.send(JSON.stringify(setupMsg));
        };

        ws.onerror = () => {
            setMicState(null);
        };

        ws.onclose = () => {
            stopSession();
        };

        ws.onmessage = async (event) => {
            let data = event.data;
            if (data instanceof Blob) {
                data = await data.text();
            }
            handleServerEvent({ data: data });
        };
    }

    function handleServerEvent(event) {
        let msg = {};
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.error) {
            console.error("API Error:", msg.error);
            return;
        }

        if (msg.setupComplete) {
            isSetupComplete = true;
            isRecording = true;
            setMicState("listening");
            startMicStreaming();
            return;
        }

        if (msg.serverContent?.modelTurn?.parts) {
            isAISpeaking = true;
            setMicState("speaking");
            for (const part of msg.serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                    playAudioChunk(part.inlineData.data);
                }
            }
        }

        if (msg.serverContent?.turnComplete) {
            isAISpeaking = false;
            setMicState("listening");
        }

        if (msg.serverContent?.interrupted) {
            stopAllAudio();
            setMicState("listening");
        }
    }

    function startMicStreaming() {
        const source = audioContext.createMediaStreamSource(mediaStream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);

        processor.onaudioprocess = (e) => {
            if (!ws || ws.readyState !== WebSocket.OPEN || !isSetupComplete) return;

            const chunk = e.inputBuffer.getChannelData(0);
            const volume = Math.sqrt(chunk.reduce((sum, val) => sum + val * val, 0) / chunk.length);

            // Higher threshold (0.08) to avoid noise triggering interrupts
            if (isAISpeaking && volume > 0.08) {
                stopAllAudio();
                setMicState("listening");
            }

            const pcm = floatTo16(chunk);
            const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm)));

            ws.send(JSON.stringify({
                realtimeInput: {
                    mediaChunks: [{
                        mimeType: "audio/pcm;rate=16000",
                        data: base64
                    }]
                }
            }));
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
    }

    function playAudioChunk(base64) {
        const raw = atob(base64);
        const buf = new ArrayBuffer(raw.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);

        const int16 = new Int16Array(buf);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++)
            float32[i] = int16[i] / 32768;

        const audioBuf = audioContext.createBuffer(1, float32.length, 24000);
        audioBuf.getChannelData(0).set(float32);

        const src = audioContext.createBufferSource();
        src.buffer = audioBuf;
        src.connect(audioContext.destination);

        activeSources.push(src);
        src.onended = () => {
            activeSources = activeSources.filter(s => s !== src);
            if (activeSources.length === 0 && !isAISpeaking) {
                setMicState("listening");
            }
        };

        const currentTime = audioContext.currentTime;
        const startTime = Math.max(currentTime, nextPlayTime);
        src.start(startTime);
        nextPlayTime = startTime + audioBuf.duration;
    }

    function stopAllAudio() {
        activeSources.forEach(src => {
            try { src.stop(); } catch (e) {}
        });
        activeSources = [];
        nextPlayTime = 0;
        isAISpeaking = false;
    }

    function stopSession() {
        isRecording = false;
        isSetupComplete = false;
        setMicState(null);
        stopAllAudio();

        if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
        if (processor) processor.disconnect();
        if (audioContext) audioContext.close();
        if (ws) ws.close();

        mediaStream = null;
        processor = null;
        audioContext = null;
        ws = null;
    }

    function floatTo16(input) {
        const buffer = new ArrayBuffer(input.length * 2);
        const dv = new DataView(buffer);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            dv.setInt16(i * 2, s * 0x7fff, true);
        }
        return buffer;
    }
});


