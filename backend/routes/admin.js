const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken, verificarAdmin } = require('../middleware/auth');

// TODAS LAS RUTAS DE ADMIN REQUIEREN TOKEN Y SER ADMIN
router.use(verificarToken, verificarAdmin);

// OBTENER TODOS LOS USUARIOS
router.get('/usuarios', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT u.*, 
                    COUNT(DISTINCT h.id) as veces_jugadas,
                    IFNULL(MAX(h.ganancia), 0) as mayor_premio,
                    (SELECT COUNT(*) FROM solicitudes_recarga 
                     WHERE usuario_id = u.id AND estado = 'pendiente') as solicitudes_pendientes
             FROM usuarios u
             LEFT JOIN historial_juego h ON u.id = h.usuario_id
             GROUP BY u.id
             ORDER BY u.id DESC`
        );

        res.json(rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// OBTENER SOLICITUDES PENDIENTES
router.get('/solicitudes-recarga', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT s.*, u.usuario 
             FROM solicitudes_recarga s
             JOIN usuarios u ON s.usuario_id = u.id
             WHERE s.estado = 'pendiente'
             ORDER BY s.fecha_solicitud DESC`
        );

        res.json(rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// APROBAR RECARGA
router.post('/aprobar-recarga', async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();

        const { solicitud_id } = req.body;

        // Obtener datos de la solicitud
        const [solicitud] = await connection.query(
            `SELECT * FROM solicitudes_recarga 
             WHERE id = ? AND estado = 'pendiente' FOR UPDATE`,
            [solicitud_id]
        );

        if (solicitud.length === 0) {
            throw new Error('Solicitud no encontrada o ya procesada');
        }

        // Actualizar solicitud
        await connection.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'aprobada', fecha_resolucion = NOW() 
             WHERE id = ?`,
            [solicitud_id]
        );

        // Agregar fichas al usuario
        await connection.query(
            `UPDATE usuarios 
             SET fichas = fichas + ?, 
                 total_recargado = total_recargado + ? 
             WHERE id = ?`,
            [solicitud[0].fichas, solicitud[0].monto, solicitud[0].usuario_id]
        );

        // Registrar transacción
        await connection.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES (?, 'recarga', ?, ?)`,
            [solicitud[0].usuario_id, solicitud[0].fichas, 'Recarga aprobada']
        );

        await connection.commit();

        res.json({ success: true });

    } catch (error) {
        await connection.rollback();
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// RECHAZAR RECARGA
router.post('/rechazar-recarga', async (req, res) => {
    try {
        const { solicitud_id } = req.body;

        await db.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'rechazada', fecha_resolucion = NOW() 
             WHERE id = ?`,
            [solicitud_id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// AGREGAR FICHAS MANUALMENTE
router.post('/agregar-fichas', async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();

        const { usuario_id, fichas } = req.body;

        await connection.query(
            `UPDATE usuarios SET fichas = fichas + ? WHERE id = ?`,
            [fichas, usuario_id]
        );

        await connection.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES (?, 'ajuste_admin', ?, 'Ajuste manual por admin')`,
            [usuario_id, fichas]
        );

        await connection.commit();

        res.json({ success: true });

    } catch (error) {
        await connection.rollback();
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    } finally {
        connection.release();
    }
});

// QUITAR FICHAS
router.post('/quitar-fichas', async (req, res) => {
    const connection = await db.getConnection();
    
    try {
        await connection.beginTransaction();

        const { usuario_id, fichas } = req.body;

        await connection.query(
            `UPDATE usuarios SET fichas = fichas - ? WHERE id = ? AND fichas >= ?`,
            [fichas, usuario_id, fichas]
        );

        await connection.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES (?, 'ajuste_admin', ?, 'Ajuste manual por admin (quitar)')`,
            [usuario_id, -fichas]
        );

        await connection.commit();

        res.json({ success: true });

    } catch (error) {
        await connection.rollback();
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    } finally {
        connection.release();
    }
});

// BLOQUEAR/ACTIVAR USUARIO
router.post('/toggle-usuario', async (req, res) => {
    try {
        const { usuario_id, activo } = req.body;

        await db.query(
            'UPDATE usuarios SET activo = ? WHERE id = ?',
            [activo, usuario_id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ESTADÍSTICAS GENERALES
router.get('/stats-tragamonedas', async (req, res) => {
    try {
        const [stats] = await db.query('SELECT * FROM vista_estadisticas_admin');

        res.json(stats[0] || {
            total_usuarios: 0,
            usuarios_activos: 0,
            fichas_totales: 0,
            total_recargas: 0,
            solicitudes_pendientes: 0
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// HISTORIAL COMPLETO
router.get('/historial-completo', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT h.*, u.usuario 
             FROM historial_juego h
             JOIN usuarios u ON h.usuario_id = u.id
             ORDER BY h.fecha DESC
             LIMIT 100`
        );

        res.json(rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});
// ============================================
// NUEVO: Estadísticas de ventas por día y hora
// ============================================
router.get('/estadisticas-ventas', async (req, res) => {
    try {
        // Estadísticas por día de la semana
        const [porDia] = await db.query(`
            SELECT 
                DAYNAME(fecha_solicitud) as dia,
                COUNT(*) as total_compras,
                SUM(fichas) as total_fichas,
                SUM(monto) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY DAYOFWEEK(fecha_solicitud), DAYNAME(fecha_solicitud)
            ORDER BY DAYOFWEEK(fecha_solicitud)
        `);

        // Estadísticas por hora del día
        const [porHora] = await db.query(`
            SELECT 
                HOUR(fecha_solicitud) as hora,
                COUNT(*) as total_compras,
                SUM(fichas) as total_fichas,
                SUM(monto) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY HOUR(fecha_solicitud)
            ORDER BY hora
        `);

        // Totales generales
        const [totales] = await db.query(`
            SELECT 
                COUNT(*) as total_recargas,
                SUM(fichas) as total_fichas,
                SUM(monto) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        // Encontrar día pico
        const diaPico = porDia.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porDia[0] || { dia: 'Sin datos', total_compras: 0 });

        // Encontrar hora pico
        const horaPico = porHora.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porHora[0] || { hora: 0, total_compras: 0 });

        // Traducción de días
        const traduccionDias = {
            'Monday': 'Lunes', 'Tuesday': 'Martes', 'Wednesday': 'Miércoles',
            'Thursday': 'Jueves', 'Friday': 'Viernes', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
        };

        // Agregar día en español
        const porDiaConEsp = porDia.map(d => ({
            ...d,
            dia_esp: traduccionDias[d.dia] || d.dia
        }));

        res.json({
            por_dia: porDiaConEsp,
            por_hora: porHora,
            totales: totales[0] || { total_recargas: 0, total_fichas: 0, total_monto: 0 },
            insights: {
                dia_pico: traduccionDias[diaPico.dia] || diaPico.dia,
                hora_pico: horaPico.hora
            }
        });

    } catch (error) {
        console.error('Error en estadísticas de ventas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});
module.exports = router;