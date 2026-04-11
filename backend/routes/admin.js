const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken, verificarAdmin } = require('../middleware/auth');

// ============================================
// RUTAS PÚBLICAS (NO requieren autenticación)
// ============================================

// OBTENER LÍMITE ACTUAL (PÚBLICO - los jugadores pueden consultarlo)
router.get('/obtener-limite', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT valor FROM configuracion WHERE clave = 'limite_premio'`
        );

        let limite = 50000;

        if (result.rows.length > 0) {
            limite = parseInt(result.rows[0].valor);
        } else {
            await db.query(
                `INSERT INTO configuracion (clave, valor) VALUES ('limite_premio', '50000')`
            );
        }

        res.json({ limite });

    } catch (error) {
        console.error('Error obteniendo límite:', error);
        res.json({ limite: 50000 });
    }
});

// ============================================
// TODAS LAS RUTAS DE ADMIN REQUIEREN TOKEN Y SER ADMIN
// ============================================
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

        const usuarios = result.rows.map(u => ({
            ...u,
            ganancias_congeladas: u.ganancias_congeladas || 0
        }));

        res.json(usuarios);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// OBTENER SOLICITUDES DE RECARGA PENDIENTES
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

// APROBAR RECARGA
router.post('/aprobar-recarga', async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        console.log('📝 Aprobando solicitud ID:', solicitud_id);

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
        const fichas = Number(solicitudData.fichas);
        const monto = Number(solicitudData.monto);
        const usuarioId = Number(solicitudData.usuario_id);

        const usuario = await client.query(
            'SELECT fichas, total_recargado, ganancias_congeladas FROM usuarios WHERE id = $1 FOR UPDATE',
            [usuarioId]
        );

        const inversion = usuario.rows[0].total_recargado || 0;
        const gananciasSesion = usuario.rows[0].fichas > inversion
            ? usuario.rows[0].fichas - inversion
            : 0;

        const nuevasGananciasCongeladas =
            (usuario.rows[0].ganancias_congeladas || 0) + gananciasSesion;

        await client.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'aprobada', fecha_resolucion = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [solicitud_id]
        );

        await client.query(
            `UPDATE usuarios 
             SET fichas = fichas + $1, 
                 total_recargado = COALESCE(total_recargado, 0) + $2,
                 ganancias_congeladas = $3
             WHERE id = $4`,
            [fichas, monto, nuevasGananciasCongeladas, usuarioId]
        );

        try {
            await client.query(
                `INSERT INTO transacciones 
                 (usuario_id, tipo, fichas, descripcion) 
                 VALUES ($1, 'recarga', $2, $3)`,
                [usuarioId, fichas, `Recarga de ${fichas} monedas`]
            );
        } catch (e) {
            console.log('⚠️ transacciones no existe');
        }

        await client.query('COMMIT');

        res.json({ success: true, message: `Agregadas ${fichas} monedas` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error:', error.message);
        res.status(500).json({ success: false, error: error.message });

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
            `UPDATE usuarios 
             SET fichas = fichas + $1
             WHERE id = $2`,
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
            `UPDATE usuarios 
             SET fichas = fichas - $1 
             WHERE id = $2 AND fichas >= $1`,
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

// ESTADÍSTICAS
router.get('/stats-tragamonedas', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT 
                (SELECT COUNT(*) FROM usuarios WHERE role = 'user') as total_usuarios,
                (SELECT COUNT(*) FROM usuarios WHERE fichas > 0) as usuarios_activos,
                (SELECT COALESCE(SUM(fichas), 0) FROM usuarios) as fichas_totales,
                (SELECT COALESCE(SUM(total_recargado), 0) FROM usuarios) as total_recargas,
                (SELECT COUNT(*) FROM solicitudes_recarga WHERE estado = 'pendiente') as solicitudes_pendientes,
                (SELECT COUNT(*) FROM solicitudes_cobro WHERE estado = 'pendiente') as cobros_pendientes`
        );

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// CONFIGURAR LÍMITE
router.post('/configurar-limite', async (req, res) => {
    try {
        const { limite } = req.body;

        await db.query(
            `INSERT INTO configuracion (clave, valor)
             VALUES ('limite_premio', $1)
             ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [limite.toString()]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// ============================================
// HISTORIAL USUARIO
// ============================================
router.get('/historial-usuario/:usuarioId', async (req, res) => {
    try {
        const { usuarioId } = req.params;

        const usuario = await db.query(
            `SELECT fichas,total_recargado,ganancias_congeladas
             FROM usuarios WHERE id=$1`,
            [usuarioId]
        );

        const u = usuario.rows[0];

        const inversion = Number(u.total_recargado || 0);
        const saldo = Number(u.fichas || 0);
        const congeladas = Number(u.ganancias_congeladas || 0);

        const gananciasSesion =
            saldo > inversion ? saldo - inversion : 0;

        const aPagar = congeladas + gananciasSesion;

        const historial = await db.query(
            `SELECT id, apuesta, ganancia, combinacion, fecha
             FROM historial_juego
             WHERE usuario_id=$1
             ORDER BY fecha DESC
             LIMIT 100`,
            [usuarioId]
        );

        res.json({
            historial: historial.rows,
            stats: {
                inversion_total: inversion,
                saldo_actual: saldo,
                ganancias_congeladas: congeladas,
                a_pagar: aPagar
            }
        });

    } catch (error) {
        console.error('Error historial:', error);
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

// ============================================
// COBROS
// ============================================

// OBTENER COBROS
router.get('/solicitudes-cobro', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT sc.*, u.usuario 
             FROM solicitudes_cobro sc
             JOIN usuarios u ON sc.usuario_id = u.id
             WHERE sc.estado = 'pendiente'
             ORDER BY sc.fecha_solicitud DESC`
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// ============================================
// 🔥 APROBAR COBRO (Opción A CORREGIDA)
// ============================================
router.post('/aprobar-cobro', async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        const solicitud = await client.query(
            `SELECT * FROM solicitudes_cobro
             WHERE id=$1 AND estado='pendiente'
             FOR UPDATE`,
            [solicitud_id]
        );

        if (solicitud.rows.length === 0) {
            throw new Error('Solicitud no encontrada');
        }

        const usuarioId = solicitud.rows[0].usuario_id;

        const usuario = await client.query(
            `SELECT fichas,total_recargado,ganancias_congeladas
             FROM usuarios
             WHERE id=$1
             FOR UPDATE`,
            [usuarioId]
        );

        const u = usuario.rows[0];

        const saldo = Number(u.fichas || 0);
        const inversion = Number(u.total_recargado || 0);
        const congeladas = Number(u.ganancias_congeladas || 0);

        const gananciasSesion =
            saldo > inversion ? saldo - inversion : 0;

        const montoReal =
            congeladas + gananciasSesion;

        // 🔥 OPCIÓN A: mantener base y resetear ganancias
        const resultado = await client.query(`
            UPDATE usuarios
            SET fichas = total_recargado,
                ganancias_congeladas = 0
            WHERE id=$1
            RETURNING fichas
        `, [usuarioId]);

        await client.query(
            `UPDATE solicitudes_cobro
             SET estado='aprobado',
                 fecha_procesado=NOW()
             WHERE id=$1`,
            [solicitud_id]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Cobro aprobado ₲${montoReal}`,
            nuevo_saldo: resultado.rows[0].fichas
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });

    } finally {
        client.release();
    }
});

// RECHAZAR COBRO
router.post('/rechazar-cobro', async (req, res) => {
    try {
        const { solicitud_id } = req.body;

        await db.query(
            `UPDATE solicitudes_cobro
             SET estado='rechazado',
                 fecha_procesado=NOW()
             WHERE id=$1`,
            [solicitud_id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

module.exports = router;
