import React, { useState, useEffect } from 'react';
import axios from 'axios';

const Dashboard = ({ user }) => {
  const [stats, setStats] = useState({
    totalOrders: 0,
    totalClients: 0,
    totalProducts: 0,
    totalQuotations: 0,
    totalRevenue: 0,
    pendingOrders: 0
  });

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const token = localStorage.getItem('token');

  // Traer datos de la BD
  const fetchData = async () => {
    try {
      const [ordersRes, clientsRes, productsRes, quotationsRes] = await Promise.all([
        axios.get('http://localhost:5000/api/orders', {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get('http://localhost:5000/api/clients', {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get('http://localhost:5000/api/products', {
          headers: { Authorization: `Bearer ${token}` }
        }),
        axios.get('http://localhost:5000/api/quotations', {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);

      const ordersData = ordersRes.data || [];
      const clientsData = clientsRes.data || [];
      const productsData = productsRes.data || [];
      const quotationsData = quotationsRes.data || [];

      // Calcular totales
      const totalRevenue = ordersData.reduce((sum, order) => sum + (order.total || 0), 0);
      const pendingCount = ordersData.filter(o => o.status === 'CREATED').length;

      setStats({
        totalOrders: ordersData.length,
        totalClients: clientsData.length,
        totalProducts: productsData.length,
        totalQuotations: quotationsData.length,
        totalRevenue,
        pendingOrders: pendingCount
      });

      setOrders(ordersData.slice(0, 5)); // Últimas 5 órdenes
      setLoading(false);
    } catch (error) {
      console.error('Error fetching data:', error);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Actualizar cada 5 segundos (sincronización)
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div style={styles.loading}>Cargando dashboard...</div>;

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Dashboard Admin - Control360</h2>
      <p style={styles.subtitle}>Resumen en tiempo real</p>

      {/* Estadísticas */}
      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalOrders}</div>
          <div style={styles.statLabel}>Órdenes Totales</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.pendingOrders}</div>
          <div style={styles.statLabel}>Órdenes Pendientes</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalClients}</div>
          <div style={styles.statLabel}>Clientes</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalProducts}</div>
          <div style={styles.statLabel}>Productos</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>{stats.totalQuotations}</div>
          <div style={styles.statLabel}>Cotizaciones</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statNumber}>
            ${(stats.totalRevenue / 1000000).toFixed(1)}M
          </div>
          <div style={styles.statLabel}>Ingresos Totales</div>
        </div>
      </div>

      {/* Últimas órdenes */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>📋 Últimas Órdenes</h3>
        {orders.length === 0 ? (
          <p>No hay órdenes</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeader}>
                <th>Order #</th>
                <th>Cliente</th>
                <th>Total</th>
                <th>Estado</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} style={styles.tableRow}>
                  <td>{order.order_number}</td>
                  <td>{order.client_id}</td>
                  <td>${(order.total || 0).toLocaleString()}</td>
                  <td>
                    <span style={{
                      ...styles.badge,
                      background: order.status === 'CREATED' ? '#ffc107' : '#28a745'
                    }}>
                      {order.status}
                    </span>
                  </td>
                  <td>{new Date(order.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Auto-refresh indicator */}
      <div style={styles.footer}>
        🔄 Actualizando cada 5 segundos
      </div>
    </div>
  );
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
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '20px',
    marginBottom: '40px'
  },
  statCard: {
    background: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    textAlign: 'center'
  },
  statNumber: {
    fontSize: '32px',
    fontWeight: 'bold',
    color: '#667eea',
    marginBottom: '10px'
  },
  statLabel: {
    fontSize: '14px',
    color: '#999'
  },
  section: {
    background: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    marginBottom: '20px'
  },
  sectionTitle: {
    margin: '0 0 20px 0',
    fontSize: '18px',
    fontWeight: '600'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse'
  },
  tableHeader: {
    background: '#f5f5f5',
    borderBottom: '2px solid #ddd'
  },
  tableRow: {
    borderBottom: '1px solid #eee'
  },
  badge: {
    padding: '4px 8px',
    borderRadius: '4px',
    color: 'white',
    fontSize: '12px',
    fontWeight: '600'
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    fontSize: '18px',
    color: '#999'
  },
  footer: {
    textAlign: 'center',
    color: '#999',
    fontSize: '12px',
    marginTop: '20px'
  }
};

export default Dashboard;