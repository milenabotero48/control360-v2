const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { Resend } = require('resend');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const snap = await db.collection('users')
      .where('email', '==', email.toLowerCase().trim())
      .limit(1).get();

    if (snap.empty) {
      return res.json({ message: 'Si el email existe recibiras un correo.' });
    }

    const userDoc = snap.docs[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await userDoc.ref.update({ resetToken: token, resetTokenExpira: expira });

    const link = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    await resend.emails.send({
      from: 'Control360 <noreply@tucontrol360.com>',
      to: email,
      subject: 'Restablecer contrasena - Control360',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h2 style="color:#7c3aed;">Control360</h2>
          <p>Recibimos una solicitud para restablecer tu contrasena.</p>
          <a href="${link}" style="display:inline-block;background:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;margin:16px 0;">
            Restablecer contrasena
          </a>
          <p style="color:#666;font-size:13px;">Este enlace vence en 1 hora. Si no solicitaste esto, ignora este correo.</p>
        </div>
      `
    });

    res.json({ message: 'Si el email existe recibiras un correo.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al procesar solicitud' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, nuevaPassword } = req.body;
    if (!token || !nuevaPassword)
      return res.status(400).json({ error: 'Token y contrasena requeridos' });

    const snap = await db.collection('users')
      .where('resetToken', '==', token)
      .limit(1).get();

    if (snap.empty)
      return res.status(400).json({ error: 'Token invalido o expirado' });

    const userDoc = snap.docs[0];
    const data = userDoc.data();

    if (new Date() > new Date(data.resetTokenExpira))
      return res.status(400).json({ error: 'Token expirado' });

    const hash = await bcrypt.hash(nuevaPassword, 10);
    await userDoc.ref.update({
      password: hash,
      resetToken: null,
      resetTokenExpira: null
    });

    res.json({ message: 'Contrasena actualizada correctamente' });
  } catch (e) {
    res.status(500).json({ error: 'Error al restablecer contrasena' });
  }
});

module.exports = router;