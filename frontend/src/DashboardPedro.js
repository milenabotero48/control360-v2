import React, { useState, useEffect } from 'react';
import axios from 'axios';

const DashboardPedro = ({ user }) => {
  const [workshop, setWorkshop] = useState([]);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await axios.get('http://localhost:5000/api/workshop', {
          headers: { Authorization: `Bearer ${token}` }
        });
        setWorkshop(res.data || []);
      } catch (err) {
        console.error('Error:', err);
      }
      setLoading(false);
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [token]);

  if (loading) return <div style={{ padding: '40px', textAlign: 'center' }}>Cargando...</div>;

  return (
    <div style={{ padding: '40px', maxWidth: '1400px', margin: '0 auto' }}>
      <h2>Dashboard Taller - Pedro</h2>
      <p style={{ color: '#999' }}>Trabajos en reparación</p>

      {workshop.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#999' }}>No hay trabajos</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {workshop.map((work) => (
            <div key={work.id} style={{ background: 'white', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
              <h3>Extintor: {work.extinguisher_id}</h3>
              <p><strong>Orden:</strong> {work.order_id.substring(0, 8)}</p>
              <p><strong>Status:</strong> {work.status}</p>
              <p style={{ fontSize: '12px', color: '#999' }}>Actualizado: {new Date(work.updated_at).toLocaleTimeString()}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ textAlign: 'center', color: '#999', fontSize: '12px', marginTop: '20px' }}>
        🔄 Actualizando cada 5 segundos
      </div>
    </div>
  );
};

export default DashboardPedro;