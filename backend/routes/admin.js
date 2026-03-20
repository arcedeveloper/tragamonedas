const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken, verificarAdmin } = require('../middleware/auth');

// TODAS LAS RUTAS DE ADMIN REQUIEREN TOKEN Y SER ADMIN
router.use(verificarToken, verificarAdmin);

// OBTENER TODOS LOS USUARIOS
router.get('/usuarios', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT u.*, 
                    COUNT(DISTINCT h.id) as veces_jugadas,
                    COALESCE(MAX(h.ganancia), 0) as mayor_premio,
                    (SELECT COUNT(*) FROM solicitudes_recarga 
                     WHERE usuario_id = u.id AND estado = 'pendiente') as solicitudes_pendientes
             FROM usuarios u
             LEFT JOIN historial_juego h ON u.id = h.usuario_id
             GROUP BY u.id
             ORDER BY u.id DESC`
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// OBTENER SOLICITUDES PENDIENTES
router.get('/solicitudes-recarga', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT s.*, u.usuario 
             FROM solicitudes_recarga s
             JOIN usuarios u ON s.usuario_id = u.id
             WHERE s.estado = 'pendiente'
             ORDER BY s.fecha_solicitud DESC`
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});
// APROBAR RECARGA - VERSIÓN CORREGIDA
router.post('/aprobar-recarga', async (req, res) => {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        console.log('📝 Aprobando solicitud ID:', solicitud_id);

        // 1. Obtener datos de la solicitud
        const solicitud = await client.query(
            `SELECT id, usuario_id, fichas, monto, estado 
             FROM solicitudes_recarga 
             WHERE id = $1 AND estado = 'pendiente' 
             FOR UPDATE`,
            [solicitud_id]
        );

        if (solicitud.rows.length === 0) {
            throw new Error('Solicitud no encontrada o ya procesada');
        }

        const solicitudData = solicitud.rows[0];
        console.log('📦 Datos:', solicitudData);

        // 2. Convertir a números correctamente
        const fichas = Number(solicitudData.fichas);
        const monto = Number(solicitudData.monto);
        const usuarioId = Number(solicitudData.usuario_id);

        // 3. Validar que no sean NaN
        if (isNaN(fichas) || isNaN(monto) || isNaN(usuarioId)) {
            throw new Error(`Datos inválidos: fichas=${fichas}, monto=${monto}, usuarioId=${usuarioId}`);
        }

        console.log(`💰 Agregando ${fichas} fichas a usuario ${usuarioId} (monto: ₲ ${monto})`);

        // 4. Actualizar solicitud
        await client.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'aprobada', fecha_resolucion = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [solicitud_id]
        );

        // 5. Actualizar usuario - IMPORTANTE: total_recargado también es numeric
        await client.query(
            `UPDATE usuarios 
             SET fichas = fichas + $1, 
                 total_recargado = total_recargado + $2 
             WHERE id = $3`,
            [fichas, monto, usuarioId]
        );

        // 6. Registrar transacción
        await client.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES ($1, 'recarga', $2, $3)`,
            [usuarioId, fichas, `Recarga de ₲ ${monto.toLocaleString()}`]
        );

        await client.query('COMMIT');
        
        console.log('✅ Recarga aprobada exitosamente');
        res.json({ success: true, message: `Agregadas ${fichas} fichas` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error en aprobar recarga:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ 
            error: error.message,
            details: error.stack
        });
    } finally {
        client.release();
    }
});

// RECHAZAR RECARGA
router.post('/rechazar-recarga', async (req, res) => {
    try {
        const { solicitud_id } = req.body;

        await db.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'rechazada', fecha_resolucion = CURRENT_TIMESTAMP 
             WHERE id = $1`,
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
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        const { usuario_id, fichas } = req.body;

        await client.query(
            `UPDATE usuarios SET fichas = fichas + $1 WHERE id = $2`,
            [fichas, usuario_id]
        );

        await client.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES ($1, 'ajuste_admin', $2, $3)`,
            [usuario_id, fichas, 'Ajuste manual por admin']
        );

        await client.query('COMMIT');

        res.json({ success: true });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// QUITAR FICHAS
router.post('/quitar-fichas', async (req, res) => {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        const { usuario_id, fichas } = req.body;

        await client.query(
            `UPDATE usuarios SET fichas = fichas - $1 WHERE id = $2 AND fichas >= $1`,
            [fichas, usuario_id]
        );

        await client.query(
            `INSERT INTO transacciones 
             (usuario_id, tipo, fichas, descripcion) 
             VALUES ($1, 'ajuste_admin', $2, $3)`,
            [usuario_id, -fichas, 'Ajuste manual por admin (quitar)']
        );

        await client.query('COMMIT');

        res.json({ success: true });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    } finally {
        client.release();
    }
});

// BLOQUEAR/ACTIVAR USUARIO
router.post('/toggle-usuario', async (req, res) => {
    try {
        const { usuario_id, activo } = req.body;

        await db.query(
            'UPDATE usuarios SET activo = $1 WHERE id = $2',
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
        const result = await db.query(
            `SELECT 
                (SELECT COUNT(*) FROM usuarios WHERE role = 'user') as total_usuarios,
                (SELECT COUNT(*) FROM usuarios WHERE fichas > 0) as usuarios_activos,
                (SELECT COALESCE(SUM(fichas), 0) FROM usuarios) as fichas_totales,
                (SELECT COALESCE(SUM(total_recargado), 0) FROM usuarios) as total_recargas,
                (SELECT COUNT(*) FROM solicitudes_recarga WHERE estado = 'pendiente') as solicitudes_pendientes`
        );

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// ESTADÍSTICAS DE VENTAS
router.get('/estadisticas-ventas', async (req, res) => {
    try {
        // Por día de la semana
        const porDia = await db.query(`
            SELECT 
                to_char(fecha_solicitud, 'Day') as dia,
                COUNT(*) as total_compras,
                COALESCE(SUM(fichas), 0) as total_fichas,
                COALESCE(SUM(monto), 0) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY EXTRACT(DOW FROM fecha_solicitud), to_char(fecha_solicitud, 'Day')
            ORDER BY EXTRACT(DOW FROM fecha_solicitud)
        `);

        // Por hora del día
        const porHora = await db.query(`
            SELECT 
                EXTRACT(HOUR FROM fecha_solicitud) as hora,
                COUNT(*) as total_compras,
                COALESCE(SUM(fichas), 0) as total_fichas,
                COALESCE(SUM(monto), 0) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY EXTRACT(HOUR FROM fecha_solicitud)
            ORDER BY hora
        `);

        // Totales
        const totales = await db.query(`
            SELECT 
                COUNT(*) as total_recargas,
                COALESCE(SUM(fichas), 0) as total_fichas,
                COALESCE(SUM(monto), 0) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= CURRENT_DATE - INTERVAL '30 days'
        `);

        // Encontrar día pico
        const diaPico = porDia.rows.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porDia.rows[0] || { dia: 'Sin datos', total_compras: 0 });

        // Encontrar hora pico
        const horaPico = porHora.rows.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porHora.rows[0] || { hora: 0, total_compras: 0 });

        // Traducción de días
        const traduccionDias = {
            'Monday': 'Lunes', 'Tuesday': 'Martes', 'Wednesday': 'Miércoles',
            'Thursday': 'Jueves', 'Friday': 'Viernes', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
        };

        // Agregar día en español
        const porDiaConEsp = porDia.rows.map(d => ({
            ...d,
            dia_esp: traduccionDias[d.dia.trim()] || d.dia
        }));

        res.json({
            por_dia: porDiaConEsp,
            por_hora: porHora.rows,
            totales: totales.rows[0] || { total_recargas: 0, total_fichas: 0, total_monto: 0 },
            insights: {
                dia_pico: traduccionDias[diaPico.dia.trim()] || diaPico.dia,
                hora_pico: horaPico.hora
            }
        });

    } catch (error) {
        console.error('Error en estadísticas de ventas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

module.exports = router;
