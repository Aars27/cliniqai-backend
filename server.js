const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Exotel ke liye zaruri

// Supabase Connection
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Twilio Connection
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ─────────────────────────────────────────────────────────────────
// ROUTE 1: GET / - Server status check
// ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ 
        status: "CliniqAI Backend Live! 🚀", 
        time: new Date().toISOString() 
    });
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 2: POST /exotel-call - Jab patient 09513886363 pe call kare
// ─────────────────────────────────────────────────────────────────
app.post('/exotel-call', async (req, res) => {
    try {
        const callerNumber = req.body.From || 
                             req.body.CallFrom || 
                             req.body.caller_id ||
                             req.body.CallSid;
        
        console.log('📞 Exotel inbound call from:', callerNumber);
        console.log('Full body:', req.body);

        // VAPI ko call karo - Riley Hindi mein baat karega
        const vapiRes = await fetch('https://api.vapi.ai/call/phone', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                assistantId: "cfc2b464-10f1-4102-93c5-387657851949",
                phoneNumberId: "690154c9-702c-4412-91c6-7225b4acda86",
                customer: {
                    number: callerNumber
                }
            })
        });

        const vapiData = await vapiRes.json();
        console.log('✅ VAPI call started:', vapiData);

        // Exotel ko XML response do
        res.set('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="woman" language="hi-IN">
        Namaste! Aapki call connect ho rahi hai. Ek second ruko.
    </Say>
    <Wait length="20"/>
</Response>`);

    } catch (err) {
        console.error('❌ Exotel error:', err);
        res.set('Content-Type', 'application/xml');
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="woman" language="hi-IN">
        Abhi system busy hai. Thodi der baad try karein.
    </Say>
</Response>`);
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3: POST /exotel-outbound - Patient ko outbound call karo
// ─────────────────────────────────────────────────────────────────
app.post('/exotel-outbound', async (req, res) => {
    try {
        const { patientPhone } = req.body;
        
        console.log('📤 Making outbound call to:', patientPhone);

        const authString = Buffer.from(
            `${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_TOKEN}`
        ).toString('base64');

        const response = await fetch(
            `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}/Calls/connect`,
            {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${authString}`
                },
                body: new URLSearchParams({
                    From: patientPhone,
                    To: process.env.EXOTEL_PHONE,
                    CallerId: process.env.EXOTEL_PHONE,
                    Url: `https://cliniqai-backend.onrender.com/exotel-call`,
                    StatusCallback: `https://cliniqai-backend.onrender.com/exotel-status`
                })
            }
        );
        
        const data = await response.json();
        console.log('✅ Outbound call response:', data);
        res.json({ success: true, call: data });
        
    } catch (err) {
        console.error('❌ Outbound call error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 4: POST /exotel-status - Call status update
// ─────────────────────────────────────────────────────────────────
app.post('/exotel-status', async (req, res) => {
    try {
        console.log('📊 Exotel status update:', req.body);
        
        const { From, To, Status, Duration } = req.body;
        
        // Database mein save karo
        await supabase.from('calls').insert([{
            patient_phone: From,
            call_type: 'general',
            duration_seconds: parseInt(Duration) || 0,
            status: Status === 'completed' ? 'completed' : 'missed',
            summary: `Exotel call - Status: ${Status}`
        }]);

        res.json({ success: true });
    } catch (err) {
        console.error('Status error:', err);
        res.json({ success: false });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 5: POST /vapi-webhook - VAPI call end report
// ─────────────────────────────────────────────────────────────────
app.post('/vapi-webhook', async (req, res) => {
    try {
        const { message } = req.body;
        
        if (message?.type !== 'end-of-call-report') {
            return res.json({ success: true });
        }

        const callData = message;
        const doctorId = callData.call?.metadata?.doctorId;
        const patientPhone = callData.call?.customer?.number;
        const summary = callData.summary || '';
        const transcript = callData.transcript || '';
        const durationSeconds = callData.durationSeconds || 0;

        console.log('📋 VAPI Call ended:', { patientPhone, durationSeconds });

        // Call type detect karo
        let callType = 'general';
        const lowercaseSummary = summary.toLowerCase();
        if (lowercaseSummary.includes('appointment') || lowercaseSummary.includes('appoint')) {
            callType = 'appointment';
        } else if (lowercaseSummary.includes('dawai') || lowercaseSummary.includes('medicine') || lowercaseSummary.includes('dawa')) {
            callType = 'medicine';
        }

        const appointmentBooked = 
            callData.analysis?.structuredData?.appointmentBooked === true || 
            lowercaseSummary.includes('booked') ||
            lowercaseSummary.includes('confirm');

        // Calls table mein save karo
        const { error: insertError } = await supabase
            .from('calls')
            .insert([{
                doctor_id: doctorId,
                patient_phone: patientPhone,
                call_type: callType,
                summary: summary,
                transcript: transcript,
                duration_seconds: durationSeconds,
                appointment_booked: appointmentBooked,
                status: 'completed'
            }]);

        if (insertError) console.error('DB insert error:', insertError);

        // Doctor ki minutes update karo
        if (doctorId) {
            const minutesUsed = Math.ceil(durationSeconds / 60);
            const { data: docData } = await supabase
                .from('Doctors table')
                .select('minutes_used')
                .eq('id', doctorId)
                .single();

            if (docData) {
                await supabase
                    .from('Doctors table')
                    .update({ minutes_used: (docData.minutes_used || 0) + minutesUsed })
                    .eq('id', doctorId);
            }
        }

        // Appointment book hua to WhatsApp bhejo
        if (appointmentBooked && patientPhone) {
            const { data: doctor } = await supabase
                .from('Doctors table')
                .select('name, clinic_name')
                .eq('id', doctorId)
                .single();

            if (doctor) {
                const appointmentTime = callData.analysis?.structuredData?.appointmentTime || 'Jaldi confirm hoga';
                const googleMapsLink = `https://maps.google.com/?q=${encodeURIComponent(doctor.clinic_name)}`;
                
                const whatsappMsg = 
                    `✅ *Appointment Confirm!*\n` +
                    `👨‍⚕️ Doctor: ${doctor.name}\n` +
                    `🏥 Clinic: ${doctor.clinic_name}\n` +
                    `🕐 Time: ${appointmentTime}\n` +
                    `📍 Location: ${googleMapsLink}\n` +
                    `🔔 2 ghante pehle reminder milega`;
                
                await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_FROM,
                    to: `whatsapp:${patientPhone}`,
                    body: whatsappMsg
                });

                console.log('✅ WhatsApp sent to patient');
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('VAPI Webhook Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 6: GET /dashboard/:doctorId - Doctor ka aaj ka data
// ─────────────────────────────────────────────────────────────────
app.get('/dashboard/:doctorId', async (req, res) => {
    try {
        const { doctorId } = req.params;
        const today = new Date().toISOString().split('T')[0];

        const { data: calls, error } = await supabase
            .from('calls')
            .select('*')
            .eq('doctor_id', doctorId)
            .gte('created_at', `${today}T00:00:00Z`);

        if (error) throw error;

        const totalCalls = calls.length;
        const appointmentsBooked = calls.filter(c => c.appointment_booked).length;
        const missedCalls = calls.filter(c => c.status === 'missed').length;
        const conversionRate = totalCalls > 0 
            ? ((appointmentsBooked / totalCalls) * 100).toFixed(2) 
            : 0;

        res.json({
            totalCalls,
            appointmentsBooked,
            missedCalls,
            conversionRate: `${conversionRate}%`,
            calls
        });
    } catch (error) {
        console.error('Dashboard Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 7: GET /doctor/:doctorId - Doctor info + products
// ─────────────────────────────────────────────────────────────────
app.get('/doctor/:doctorId', async (req, res) => {
    try {
        const { doctorId } = req.params;

        const { data: doctor, error: docError } = await supabase
            .from('Doctors table')
            .select('*')
            .eq('id', doctorId)
            .single();

        if (docError) throw docError;

        const { data: products } = await supabase
            .from('products')
            .select('*')
            .eq('doctor_id', doctorId)
            .eq('available', true);

        res.json({ doctor, products: products || [] });
    } catch (error) {
        console.error('Doctor Route Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 8: POST /appointment - Naya appointment save + WhatsApp
// ─────────────────────────────────────────────────────────────────
app.post('/appointment', async (req, res) => {
    try {
        const { doctor_id, patient_name, patient_phone, appointment_time } = req.body;

        const { data: appointment, error: insertError } = await supabase
            .from('appointments')
            .insert([{
                doctor_id,
                patient_name,
                patient_phone,
                appointment_time,
                status: 'confirmed'
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        const { data: doctor } = await supabase
            .from('Doctors table')
            .select('name, clinic_name, whatsapp')
            .eq('id', doctor_id)
            .single();

        if (doctor) {
            const googleMapsLink = `https://maps.google.com/?q=${encodeURIComponent(doctor.clinic_name)}`;
            
            // Patient ko confirmation
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_FROM,
                to: `whatsapp:${patient_phone}`,
                body: `✅ *Appointment Confirm!*\n👨‍⚕️ Doctor: ${doctor.name}\n🏥 Clinic: ${doctor.clinic_name}\n🕐 Time: ${appointment_time}\n📍 Location: ${googleMapsLink}\n🔔 2 ghante pehle reminder milega`
            });

            // Doctor ko notification
            if (doctor.whatsapp) {
                await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_FROM,
                    to: `whatsapp:${doctor.whatsapp}`,
                    body: `🔔 *Naya Appointment!*\n👤 Patient: ${patient_name}\n📞 Number: ${patient_phone}\n🕐 Time: ${appointment_time}`
                });
            }
        }

        res.json({ success: true, appointment });
    } catch (error) {
        console.error('Appointment Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 9: GET /calls/:doctorId - Saari calls with filters
// ─────────────────────────────────────────────────────────────────
app.get('/calls/:doctorId', async (req, res) => {
    try {
        const { doctorId } = req.params;
        const { date, type } = req.query;

        let query = supabase
            .from('calls')
            .select('*')
            .eq('doctor_id', doctorId);

        if (date === 'today') {
            const today = new Date().toISOString().split('T')[0];
            query = query.gte('created_at', `${today}T00:00:00Z`);
        }

        if (type) query = query.eq('call_type', type);

        const { data: calls, error } = await query
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(calls);
    } catch (error) {
        console.error('Calls Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CliniqAI Backend Live on port ${PORT} 🚀`);
});