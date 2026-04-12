const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken, verificarAdmin } = require('../middleware/auth');

/* ==================================================
   RUTA PÚBLICA
================================================== */

// OBTENER LÍMITE ACTUAL
router.get('/obtener-limite', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT valor 
             FROM configuracion 
             WHERE clave = 'limite_premio'`
        );

        let limite = 50000;

        if (result.rows.length > 0) {
            limite = parseInt(result.rows[0].valor);
        } else {
            await db.query(
                `INSERT INTO configuracion (clave, valor)
                 VALUES ('limite_premio', '50000')`
            );
        }

        res.json({ limite });

    } catch (error) {
        console.error(error);
        res.json({ limite: 50000 });
    }
});

/* ==================================================
   TODAS LAS RUTAS DE ABAJO SON ADMIN
================================================== */

router.use(verificarToken, verificarAdmin);

/* ==================================================
   USUARIOS
================================================== */

// LISTAR USUARIOS
router.get('/usuarios', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT 
                u.*,
                COUNT(h.id) AS veces_jugadas,
                COALESCE(MAX(h.ganancia),0) AS mayor_premio
            FROM usuarios u
            LEFT JOIN historial_juego h 
                ON h.usuario_id = u.id
            GROUP BY u.id
            ORDER BY u.id DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// BLOQUEAR / ACTIVAR
router.post('/toggle-usuario', async (req, res) => {
    try {
        const { usuario_id, activo } = req.body;

        await db.query(
            `UPDATE usuarios
             SET activo = $1
             WHERE id = $2`,
            [activo, usuario_id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   RECARGAS
================================================== */

// VER SOLICITUDES
router.get('/solicitudes-recarga', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT s.*, u.usuario
            FROM solicitudes_recarga s
            JOIN usuarios u ON u.id = s.usuario_id
            WHERE s.estado = 'pendiente'
            ORDER BY s.fecha_solicitud DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// APROBAR RECARGA
router.post('/aprobar-recarga', async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        const solicitud = await client.query(`
            SELECT *
            FROM solicitudes_recarga
            WHERE id = $1
            AND estado = 'pendiente'
            FOR UPDATE
        `, [solicitud_id]);

        if (solicitud.rows.length === 0) {
            throw new Error('Solicitud no encontrada');
        }

        const s = solicitud.rows[0];

        const usuario = await client.query(`
            SELECT fichas,total_recargado,ganancias_congeladas
            FROM usuarios
            WHERE id = $1
            FOR UPDATE
        `, [s.usuario_id]);

        const u = usuario.rows[0];

        const saldo = Number(u.fichas || 0);
        const inversion = Number(u.total_recargado || 0);
        const congeladas = Number(u.ganancias_congeladas || 0);

        // ganancias actuales antes de recargar
        const gananciasSesion = saldo > inversion
            ? saldo - inversion
            : 0;

        const nuevasCongeladas =
            congeladas + gananciasSesion;

        // aprobar solicitud
        await client.query(`
            UPDATE solicitudes_recarga
            SET estado = 'aprobada',
                fecha_resolucion = NOW()
            WHERE id = $1
        `, [solicitud_id]);

        // 🔥 SUMA fichas, NO reinicia
        await client.query(`
            UPDATE usuarios
            SET fichas = fichas + $1,
                total_recargado = total_recargado + $2,
                ganancias_congeladas = $3
            WHERE id = $4
        `, [
            s.fichas,
            s.monto,
            nuevasCongeladas,
            s.usuario_id
        ]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Recarga aprobada'
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

// RECHAZAR RECARGA
router.post('/rechazar-recarga', async (req, res) => {
    try {
        const { solicitud_id } = req.body;

        await db.query(`
            UPDATE solicitudes_recarga
            SET estado = 'rechazada',
                fecha_resolucion = NOW()
            WHERE id = $1
        `, [solicitud_id]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   FICHAS MANUALES
================================================== */

// AGREGAR FICHAS
router.post('/agregar-fichas', async (req, res) => {
    try {
        const { usuario_id, fichas } = req.body;

        await db.query(`
            UPDATE usuarios
            SET fichas = fichas + $1
            WHERE id = $2
        `, [fichas, usuario_id]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// QUITAR FICHAS
router.post('/quitar-fichas', async (req, res) => {
    try {
        const { usuario_id, fichas } = req.body;

        await db.query(`
            UPDATE usuarios
            SET fichas = GREATEST(fichas - $1, 0)
            WHERE id = $2
        `, [fichas, usuario_id]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   COBROS
================================================== */

// VER COBROS
router.get('/solicitudes-cobro', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT sc.*, u.usuario
            FROM solicitudes_cobro sc
            JOIN usuarios u ON u.id = sc.usuario_id
            WHERE sc.estado = 'pendiente'
            ORDER BY sc.fecha_solicitud DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

// APROBAR COBRO
router.post('/aprobar-cobro', async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        const solicitud = await client.query(`
            SELECT *
            FROM solicitudes_cobro
            WHERE id = $1
            AND estado = 'pendiente'
            FOR UPDATE
        `, [solicitud_id]);

        if (solicitud.rows.length === 0) {
            throw new Error('Solicitud no encontrada');
        }

        const usuarioId = solicitud.rows[0].usuario_id;

        const usuario = await client.query(`
            SELECT fichas,total_recargado,ganancias_congeladas
            FROM usuarios
            WHERE id = $1
            FOR UPDATE
        `, [usuarioId]);

        const u = usuario.rows[0];

        const saldo = Number(u.fichas || 0);
        const inversion = Number(u.total_recargado || 0);
        const congeladas = Number(u.ganancias_congeladas || 0);

        const gananciasSesion =
            saldo > inversion ? saldo - inversion : 0;

        const montoReal =
            congeladas + gananciasSesion;

        // 🔥 deja base cargada, paga ganancias
        await client.query(`
            UPDATE usuarios
            SET fichas = total_recargado,
                ganancias_congeladas = 0
            WHERE id = $1
        `, [usuarioId]);

        await client.query(`
            UPDATE solicitudes_cobro
            SET estado = 'aprobado',
                fecha_procesado = NOW()
            WHERE id = $1
        `, [solicitud_id]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Cobro aprobado ₲${montoReal}`
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

        await db.query(`
            UPDATE solicitudes_cobro
            SET estado = 'rechazado',
                fecha_procesado = NOW()
            WHERE id = $1
        `, [solicitud_id]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   HISTORIAL
================================================== */

router.get('/historial-usuario/:usuarioId', async (req, res) => {
    try {
        const { usuarioId } = req.params;

        const historial = await db.query(`
            SELECT id, apuesta, ganancia, combinacion, fecha
            FROM historial_juego
            WHERE usuario_id = $1
            ORDER BY fecha DESC
            LIMIT 100
        `, [usuarioId]);

        const usuario = await db.query(`
            SELECT fichas,total_recargado,ganancias_congeladas
            FROM usuarios
            WHERE id = $1
        `, [usuarioId]);

        const u = usuario.rows[0];

        const saldo = Number(u.fichas || 0);
        const inversion = Number(u.total_recargado || 0);
        const congeladas = Number(u.ganancias_congeladas || 0);

        const gananciasSesion =
            saldo > inversion ? saldo - inversion : 0;

        const aPagar =
            congeladas + gananciasSesion;

        res.json({
            historial: historial.rows,
            stats: {
                saldo_actual: saldo,
                inversion_total: inversion,
                ganancias_congeladas: congeladas,
                a_pagar: aPagar
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   STATS
================================================== */

router.get('/stats-tragamonedas', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM usuarios WHERE role='user') AS total_usuarios,
                (SELECT COUNT(*) FROM usuarios WHERE fichas > 0) AS usuarios_activos,
                (SELECT COALESCE(SUM(fichas),0) FROM usuarios) AS fichas_totales,
                (SELECT COALESCE(SUM(total_recargado),0) FROM usuarios) AS total_recargas
        `);

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

/* ==================================================
   CONFIGURAR LÍMITE
================================================== */

router.post('/configurar-limite', async (req, res) => {
    try {
        const { limite } = req.body;

        await db.query(`
            INSERT INTO configuracion (clave, valor)
            VALUES ('limite_premio', $1)
            ON CONFLICT (clave)
            DO UPDATE SET valor = EXCLUDED.valor
        `, [String(limite)]);

        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error servidor' });
    }
});

module.exports = router;
