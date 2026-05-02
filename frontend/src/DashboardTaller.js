import React, { useState, useEffect } from 'react';
import axios from 'axios';

const DashboardTaller = ({ user }) => {
  const [trabajos, setTrabajos] = useState([]);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');

  const cargarTrabajos = async () => {
    try {
      const response = await axios.get('http://localhost:5000/api/workshop', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data) {
        setTrabajos(response.data);
      }
    } catch (error) {
      console.error('Error:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    cargarTrabajos();
    const intervalo = setInterval(cargarTrabajos, 5000);
    return () => clearInterval(intervalo);
  }, [token]);

  const cambiarEstado = async (id, nuevoEstado) => {
    try {
      await axios.put(
        `http://localhost:5000/api/workshop/${id}`,
        { status: nuevoEstado },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      cargarTrabajos();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#999' }}>Cargando trabajos...</div>;
  }

  const obtenerColor = (estado) => {
    const colores = {
      'PENDING_INSPECTION': '#ffc107',
      'IN_REPAIR': '#ff9800',
      'TESTING': '#0066cc',
      'READY': '#28a745'
    };
    return colores[estado] || '#666';
  };

  return (
    <div style={{ padding: '40px', maxWidth: '1400px', margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 10px 0', fontSize: '28px', fontWeight: 'bold', color: '#333' }}>
        Dashboard Taller - Pedro
      </h2>
      <p style={{ color: '#999', marginBottom: '30px' }}>
        Inspección y reparación de equipos
      </p>

      {trabajos.length === 0 ? (
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '8px',
          textAlign: 'center',
          color: '#999'
        }}>
          No hay trabajos pendientes
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '20px'
        }}>
          {trabajos.map((trabajo) => (
            <div
              key={trabajo.id}
              style={{
                background: 'white',
                borderRadius: '8px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                overflow: 'hidden'
              }}
            >
              <div style={{
                background: '#f5f5f5',
                padding: '15px',
                borderBottom: '1px solid #eee',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>
                  Extintor: {trabajo.extinguisher_id}
                </h3>
                <span style={{
                  background: obtenerColor(trabajo.status),
                  color: 'white',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '600'
                }}>
                  {trabajo.status}
                </span>
              </div>

              <div style={{ padding: '20px' }}>
                <p style={{ margin: '0 0 15px 0', fontSize: '14px' }}>
                  <strong>Orden:</strong> {trabajo.order_id.substring(0, 8)}
                </p>

                <div style={{
                  background: '#f9f9f9',
                  padding: '12px',
                  borderRadius: '6px',
                  marginBottom: '15px',
                  fontSize: '13px'
                }}>
                  <p style={{ margin: '0 0 10px 0', fontWeight: '600' }}>📋 Checklist:</p>
                  {trabajo.inspection_checklist && Object.entries(trabajo.inspection_checklist).map(([clave, valor]) => (
                    <div key={clave} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '6px',
                      color: valor ? '#28a745' : '#999'
                    }}>
                      <span>{valor ? '✓' : '○'}</span>
                      <span>{clave.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '10px' }}>
                  {trabajo.status === 'PENDING_INSPECTION' && (
                    <button
                      onClick={() => cambiarEstado(trabajo.id, 'IN_REPAIR')}
                      style={{
                        flex: 1,
                        padding: '10px',
                        background: '#ff9800',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: '600'
                      }}
                    >
                      Reparar
                    </button>
                  )}
                  {trabajo.status === 'IN_REPAIR' && (
                    <button
                      onClick={() => cambiarEstado(trabajo.id, 'TESTING')}
                      style={{
                        flex: 1,
                        padding: '10px',
                        background: '#0066cc',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: '600'
                      }}
                    >
                      Probar
                    </button>
                  )}
                  {trabajo.status === 'TESTING' && (
                    <button
                      onClick={() => cambiarEstado(trabajo.id, 'READY')}
                      style={{
                        flex: 1,
                        padding: '10px',
                        background: '#28a745',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: '600'
                      }}
                    >
                      Listo
                    </button>
                  )}
                </div>
              </div>

              <div style={{
                background: '#f5f5f5',
                padding: '10px 15px',
                borderTop: '1px solid #eee',
                fontSize: '11px',
                color: '#999'
              }}>
                {new Date(trabajo.updated_at).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{
        textAlign: 'center',
        color: '#999',
        fontSize: '12px',
        marginTop: '30px'
      }}>
        🔄 Actualizando cada 5 segundos
      </div>
    </div>
  );
};

export default DashboardTaller;