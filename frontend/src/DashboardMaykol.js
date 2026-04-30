import React, { useState, useEffect } from 'react';
import axios from 'axios';

const DashboardMaykol = ({ user }) => {
  const [logistics, setLogistics] = useState([]);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');

  // Traer entregas asignadas a Maykol
  const fetchLogistics = async () => {
    try {
      const response = await axios.get('http://localhost:5000/api/logistics', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = response.data || [];
      // Filtrar solo las de Maykol (code 0000)
      const maykols = data.filter(l => l.messenger_id === '0000');
      setLogistics(maykols);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching logistics:', error);
      setLoading(false);
    }
  };

  const updateStatus = async (logisticId, newStatus) => {
    try {
      await axios.put(`http://localhost:5000/api/logistics/${logisticId}`, 
        { status: newStatus },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fetchLogistics(); // Refrescar
    } catch (error) {
      console.error('Error updating status:', error);
    }
  };

  const updateGPS = async (logisticId, type) => {
    // Simular GPS (en producción sería geolocalización real)
    const lat = (3.4 + Math.random() * 0.1).toFixed(4);
    const lng = (-76.5 + Math.random() * 0.1).toFixed(4);
    
    try {
      if (type === 'pickup') {
        await axios.put(`http://localhost:5000/api/logistics/${logisticId}`, 
          { gps_pickup: { lat, lng }, status: 'PICKED_UP' },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      } else {
        await axios.put(`http://localhost:5000/api/logistics/${logisticId}`, 
          { gps_delivery: { lat, lng }, status: 'DELIVERED' },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
      fetchLogistics();
    } catch (error) {
      console.error('Error updating GPS:', error);
    }
  };

  useEffect(() => {
    fetchLogistics();
    const interval = setInterval(fetchLogistics, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div style={styles.loading}>Cargando entregas...</div>;

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Dashboard Logística - Maykol</h2>
      <p style={styles.subtitle}>Entregas en ruta</p>

      {logistics.length === 0 ? (
        <div style={styles.empty}>No hay entregas asignadas</div>
      ) : (
        <div style={styles.grid}>
          {logistics.map((log) => (
            <div key={log.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <h3>Orden: {log.order_id.substring(0, 8)}</h3>
                <span style={{
                  ...styles.badge,
                  background: getBadgeColor(log.status)
                }}>
                  {log.status}
                </span>
              </div>

              <div style={styles.cardBody}>
                <p><strong>📍 Recogida:</strong> {log.pickup_address}</p>
                <p><strong>🏠 Entrega:</strong> {log.delivery_address}</p>

                <div style={styles.gpsSection}>
                  <p><strong>📡 GPS Recogida:</strong></p>
                  {log.gps_pickup ? (
                    <p style={styles.gpsData}>
                      {log.gps_pickup.lat}, {log.gps_pickup.lng}
                    </p>
                  ) : (
                    <p style={styles.gpsEmpty}>No registrado</p>
                  )}
                  {!log.gps_pickup && log.status === 'PENDING_PICKUP' && (
                    <button
                      onClick={() => updateGPS(log.id, 'pickup')}
                      style={styles.btn}
                    >
                      ✓ Registrar recogida
                    </button>
                  )}
                </div>

                <div style={styles.gpsSection}>
                  <p><strong>📡 GPS Entrega:</strong></p>
                  {log.gps_delivery ? (
                    <p style={styles.gpsData}>
                      {log.gps_delivery.lat}, {log.gps_delivery.lng}
                    </p>
                  ) : (
                    <p style={styles.gpsEmpty}>No registrado</p>
                  )}
                  {!log.gps_delivery && log.status !== 'DELIVERED' && log.status !== 'PENDING_PICKUP' && (
                    <button
                      onClick={() => updateGPS(log.id, 'delivery')}
                      style={styles.btn}
                    >
                      ✓ Registrar entrega
                    </button>
                  )}
                </div>

                <div style={styles.actions}>
                  {log.status === 'PENDING_PICKUP' && (
                    <button
                      onClick={() => updateStatus(log.id, 'IN_TRANSIT')}
                      style={{...styles.actionBtn, background: '#0066cc'}}
                    >
                      Salir en ruta
                    </button>
                  )}
                  {log.status === 'IN_TRANSIT' && (
                    <button
                      onClick={() => updateStatus(log.id, 'DELIVERED')}
                      style={{...styles.actionBtn, background: '#28a745'}}
                    >
                      Marcar entregado
                    </button>
                  )}
                </div>
              </div>

              <div style={styles.cardFooter}>
                Actualizado: {new Date(log.updated_at).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.footer}>
        🔄 Actualizando cada 5 segundos
      </div>
    </div>
  );
};

const getBadgeColor = (status) => {
  const colors = {
    'PENDING_PICKUP': '#ffc107',
    'IN_TRANSIT': '#0066cc',
    'DELIVERED': '#28a745',
    'FAILED': '#dc3545'
  };
  return colors[status] || '#999';
};

const styles = {
  container: {
    padding: '40px',
    maxWidth: '1400px',
    margin: '0 auto'
  },
  title: {
    fontSize: '28px',
    fontWeight: 'bold',
    margin: '0 0 5px 0',
    color: '#333'
  },
  subtitle: {
    color: '#999',
    marginBottom: '30px'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
    gap: '20px',
    marginBottom: '40px'
  },
  card: {
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    overflow: 'hidden'
  },
  cardHeader: {
    background: '#f5f5f5',
    padding: '15px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #eee'
  },
  cardBody: {
    padding: '20px'
  },
  gpsSection: {
    background: '#f9f9f9',
    padding: '15px',
    borderRadius: '6px',
    marginBottom: '15px'
  },
  gpsData: {
    fontSize: '12px',
    fontFamily: 'monospace',
    color: '#0066cc',
    margin: '5px 0'
  },
  gpsEmpty: {
    fontSize: '12px',
    color: '#999',
    margin: '5px 0'
  },
  badge: {
    padding: '6px 12px',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    fontWeight: '600'
  },
  btn: {
    background: '#667eea',
    color: 'white',
    border: 'none',
    padding: '8px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    marginTop: '8px'
  },
  actions: {
    display: 'flex',
    gap: '10px',
    marginTop: '15px'
  },
  actionBtn: {
    flex: 1,
    padding: '10px',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600'
  },
  cardFooter: {
    background: '#f5f5f5',
    padding: '10px 15px',
    fontSize: '12px',
    color: '#999',
    borderTop: '1px solid #eee'
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    fontSize: '18px',
    color: '#999'
  },
  empty: {
    textAlign: 'center',
    padding: '40px',
    background: 'white',
    borderRadius: '8px',
    color: '#999'
  },
  footer: {
    textAlign: 'center',
    color: '#999',
    fontSize: '12px'
  }
};

export default DashboardMaykol;