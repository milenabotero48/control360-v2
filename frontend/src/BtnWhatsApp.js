// ============================================================
// Control360 — Botón flotante de soporte WhatsApp
// Ubicación: frontend/src/BtnWhatsApp.js
// ------------------------------------------------------------
// Aparece en la esquina inferior derecha de toda la app.
// Solo visible para usuarios logueados.
// Abre WhatsApp con mensaje prellenado al hacer clic.
// No interfiere con ningún módulo existente.
// ============================================================

import React, { useState } from 'react';

const WHATSAPP = '573234152442';
const MENSAJE  = encodeURIComponent('Hola Sandra, tengo una consulta sobre Control360 🙌');

export default function BtnWhatsApp() {
  const [hover, setHover] = useState(false);

  return (
    <a
      href={`https://wa.me/${WHATSAPP}?text=${MENSAJE}`}
      target="_blank"
      rel="noreferrer"
      title="Soporte por WhatsApp"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position:        'fixed',
        bottom:          20,
        right:           20,
        zIndex:          300,
        display:         'flex',
        alignItems:      'center',
        gap:             10,
        background:      '#25D366',
        color:           '#fff',
        borderRadius:    hover ? 50 : 50,
        padding:         hover ? '10px 18px 10px 14px' : '12px',
        boxShadow:       '0 4px 16px rgba(37,211,102,0.4)',
        textDecoration:  'none',
        fontWeight:      700,
        fontSize:        13,
        transition:      'all .25s ease',
        overflow:        'hidden',
        whiteSpace:      'nowrap',
        maxWidth:        hover ? 220 : 48,
      }}
    >
      {/* Icono WhatsApp SVG */}
      <svg width="22" height="22" viewBox="0 0 32 32" fill="currentColor" style={{ flexShrink: 0 }}>
        <path d="M16 2C8.268 2 2 8.268 2 16c0 2.47.675 4.782 1.847 6.762L2 30l7.438-1.822A13.93 13.93 0 0016 30c7.732 0 14-6.268 14-14S23.732 2 16 2zm0 25.6a11.56 11.56 0 01-5.9-1.616l-.42-.25-4.415 1.082 1.113-4.3-.275-.44A11.54 11.54 0 014.4 16C4.4 9.592 9.592 4.4 16 4.4S27.6 9.592 27.6 16 22.408 27.6 16 27.6zm6.32-8.636c-.347-.174-2.05-1.01-2.37-1.126-.32-.115-.552-.174-.784.174-.232.347-.9 1.126-1.102 1.358-.203.232-.406.26-.754.087-.347-.174-1.466-.54-2.793-1.72-1.032-.92-1.728-2.055-1.93-2.402-.202-.347-.022-.535.152-.708.156-.155.347-.406.52-.61.174-.202.232-.346.347-.578.116-.23.058-.434-.029-.608-.087-.174-.783-1.89-1.074-2.59-.283-.68-.57-.587-.783-.598l-.667-.012c-.232 0-.608.087-.927.434-.319.347-1.218 1.19-1.218 2.9 0 1.71 1.247 3.36 1.42 3.593.174.232 2.454 3.747 5.945 5.254.831.36 1.48.574 1.986.734.834.266 1.594.228 2.194.138.67-.1 2.05-.838 2.34-1.647.29-.81.29-1.503.203-1.648-.087-.145-.319-.232-.666-.406z"/>
      </svg>

      {/* Texto que aparece al hacer hover */}
      <span style={{
        opacity:    hover ? 1 : 0,
        maxWidth:   hover ? 160 : 0,
        transition: 'all .25s ease',
        overflow:   'hidden',
      }}>
        ¿Necesitas ayuda?
      </span>
    </a>
  );
}
