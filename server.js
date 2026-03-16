require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

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
// ROUTE 1: GET / - Server status check karne ke liye
// ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ 
        status: "CliniqAI Backend Live!", 
        time: new Date().toISOString() 
    });
});


// India pe outbound call karo
app.post('/call-patient', async (req, res) => {
  try {
    const { patientPhone } = req.body;
    
    const response = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: "cfc2b464-10f1-4102-93c5-387657851949",
        phoneNumberId: "690154c9-702c-4412-91c6-7225b4acda86",
        customer: {
          number: patientPhone,
          name: "Patient"
        }
      })
    });
    
    const data = await response.json();
    console.log('Call started:', data);
    res.json({ success: true, call: data });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/make-call', async (req, res) => {
  const { patientPhone } = req.body;
  
  const response = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: "cfc2b464-...", 
      phoneNumberId: "abebdd20-...", 
      customer: {
        number: patientPhone 
      }
    })
  });
  
  res.json(await response.json());
});



// ─────────────────────────────────────────────────────────────────
// ROUTE 2: POST /vapi-webhook - VAPI call end report handle karne ke liye
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

        // Call type detect karo summary keywords se
        let callType = 'general';
        const lowercaseSummary = summary.toLowerCase();
        if (lowercaseSummary.includes('appointment') || lowercaseSummary.includes('appoint')) {
            callType = 'appointment';
        } else if (lowercaseSummary.includes('dawai') || lowercaseSummary.includes('medicine') || lowercaseSummary.includes('dawa')) {
            callType = 'medicine';
        }

        // Detect if appointment was booked (VAPI logic based on summary or metadata)
        // Yahan user ne bola hai: "If appointment_booked=true, send WhatsApp via Twilio"
        // VAPI webhook message me appointment_booked usually metadata ya analysis me hota hai
        const appointmentBooked = callData.analysis?.structuredData?.appointmentBooked === true || lowercaseSummary.includes('booked');

        // Save to "calls" table
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

        if (insertError) throw insertError;

        // Update doctor minutes_used in "Doctors table"
        if (doctorId) {
            const minutesUsed = Math.ceil(durationSeconds / 60);
            const { data: docData, error: fetchError } = await supabase
                .from('"Doctors table"')
                .select('minutes_used')
                .eq('id', doctorId)
                .single();

            if (!fetchError) {
                const newMinutes = (docData.minutes_used || 0) + minutesUsed;
                await supabase
                    .from('"Doctors table"')
                    .update({ minutes_used: newMinutes })
                    .eq('id', doctorId);
            }
        }

        // If appointment booked, send WhatsApp via Twilio
        if (appointmentBooked && patientPhone) {
            // Get doctor info for WhatsApp
            const { data: doctor } = await supabase
                .from('"Doctors table"')
                .select('name, clinic_name')
                .eq('id', doctorId)
                .single();

            if (doctor) {
                const appointmentTime = callData.analysis?.structuredData?.appointmentTime || 'TBD';
                const googleMapsLink = `https://maps.google.com/?q=${encodeURIComponent(doctor.clinic_name)}`;
                
                const whatsappMsg = `✅ Appointment Confirm!\n👨‍⚕️ Doctor: ${doctor.name}\n🏥 Clinic: ${doctor.clinic_name}\n🕐 Time: ${appointmentTime}\n📍 Location: ${googleMapsLink}\n🔔 2 ghante pehle reminder milega`;
                
                await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_FROM,
                    to: `whatsapp:${patientPhone}`,
                    body: whatsappMsg
                });
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('VAPI Webhook Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3: GET /dashboard/:doctorId - Doctor stats nikalne ke liye
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
        const conversionRate = totalCalls > 0 ? ((appointmentsBooked / totalCalls) * 100).toFixed(2) : 0;

        res.json({
            totalCalls,
            appointmentsBooked,
            missedCalls,
            conversionRate: `${conversionRate}%`,
            calls
        });
    } catch (error) {
        console.error('Dashboard Route Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 4: GET /doctor/:doctorId - Doctor aur Products ki details
// ─────────────────────────────────────────────────────────────────
app.get('/doctor/:doctorId', async (req, res) => {
    try {
        const { doctorId } = req.params;

        const { data: doctor, error: docError } = await supabase
            .from('"Doctors table"')
            .select('*')
            .eq('id', doctorId)
            .single();

        if (docError) throw docError;

        const { data: products, error: prodError } = await supabase
            .from('products')
            .select('*')
            .eq('doctor_id', doctorId)
            .eq('available', true);

        if (prodError) throw prodError;

        res.json({ doctor, products });
    } catch (error) {
        console.error('Doctor Route Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 5: POST /appointment - Naya appointment save karne ke liye
// ─────────────────────────────────────────────────────────────────
app.post('/appointment', async (req, res) => {
    try {
        const { doctor_id, patient_name, patient_phone, appointment_time } = req.body;

        // Save to appointments table
        const { data: appointment, error: insertError } = await supabase
            .from('appointments')
            .insert([{
                doctor_id,
                patient_name,
                patient_phone,
                appointment_time,
                status: 'pending'
            }])
            .select()
            .single();

        if (insertError) throw insertError;

        // Get doctor info for WhatsApp
        const { data: doctor } = await supabase
            .from('"Doctors table"')
            .select('name, clinic_name, phone, whatsapp')
            .eq('id', doctor_id)
            .single();

        if (doctor) {
            const googleMapsLink = `https://maps.google.com/?q=${encodeURIComponent(doctor.clinic_name)}`;
            
            // Patient confirmation
            const patientMsg = `✅ Appointment Confirm!\n👨‍⚕️ Doctor: ${doctor.name}\n🏥 Clinic: ${doctor.clinic_name}\n🕐 Time: ${appointment_time}\n📍 Location: ${googleMapsLink}\n🔔 2 ghante pehle reminder milega`;
            
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_FROM,
                to: `whatsapp:${patient_phone}`,
                body: patientMsg
            });

            // Doctor notification
            const doctorMsg = `🔔 Naya Appointment!\n👤 Patient: ${patient_name}\n📞 Number: ${patient_phone}\n🕐 Time: ${appointment_time}`;
            
            // Use doctor's whatsapp column
            if (doctor.whatsapp) {
                await twilioClient.messages.create({
                    from: process.env.TWILIO_WHATSAPP_FROM,
                    to: `whatsapp:${doctor.whatsapp}`,
                    body: doctorMsg
                });
            }
        }

        res.json({ success: true, appointment });
    } catch (error) {
        console.error('Appointment Route Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 6: GET /calls/:doctorId - Saari calls filter ke saath
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

        if (type) {
            query = query.eq('call_type', type);
        }

        const { data: calls, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;

        res.json(calls);
    } catch (error) {
        console.error('Calls Route Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`CliniqAI Backend Live on port ${PORT} 🚀`);
});
