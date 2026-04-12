const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verificarToken } = require('../middleware/auth');

// OBTENER USUARIO ACTUAL
router.get('/usuario', verificarToken, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, usuario, fichas, total_recargado, ganancias_congeladas 
             FROM usuarios 
             WHERE id = $1`,
            [req.usuario.id]
        );

        res.json({
            usuario: result.rows[0]
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// JUGAR
router.post('/jugar', verificarToken, async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const { apuesta, ganancia, combinacion } = req.body;
        const usuarioId = req.usuario.id;

        // Bloquear usuario
        const usuario = await client.query(
            `SELECT fichas, total_recargado, ganancias_congeladas
             FROM usuarios
             WHERE id = $1
             FOR UPDATE`,
            [usuarioId]
        );

        if (usuario.rows.length === 0) {
            throw new Error('Usuario no encontrado');
        }

        const saldoActual = Number(usuario.rows[0].fichas || 0);

        if (saldoActual < apuesta) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Fichas insuficientes' });
        }

        // Guardar historial
        await client.query(
            `INSERT INTO historial_juego
             (usuario_id, apuesta, ganancia, combinacion)
             VALUES ($1, $2, $3, $4)`,
            [usuarioId, apuesta, ganancia, combinacion]
        );

        // Descontar apuesta + sumar premio
        await client.query(
            `UPDATE usuarios
             SET fichas = fichas - $1 + $2,
                 veces_jugadas = veces_jugadas + 1
             WHERE id = $3`,
            [apuesta, ganancia, usuarioId]
        );

        // 🔥 NUEVO: si quedó sin fichas, resetear meta automáticamente
        await client.query(
            `UPDATE usuarios
             SET total_recargado = 0,
                 ganancias_congeladas = 0
             WHERE id = $1
             AND fichas <= 0`,
            [usuarioId]
        );

        // Registrar movimientos (si existe tabla)
        try {
            await client.query(
                `INSERT INTO transacciones
                 (usuario_id, tipo, fichas, descripcion)
                 VALUES ($1, 'jugada', $2, $3)`,
                [usuarioId, -apuesta, `Apuesta de ${apuesta} fichas`]
            );

            if (ganancia > 0) {
                await client.query(
                    `INSERT INTO transacciones
                     (usuario_id, tipo, fichas, descripcion)
                     VALUES ($1, 'premio', $2, $3)`,
                    [usuarioId, ganancia, `Premio por combinación ${combinacion}`]
                );
            }

        } catch (transError) {
            console.log('⚠️ Tabla transacciones no existe, continuando...');
        }

        await client.query('COMMIT');

        // Obtener saldo final
        const nuevoUsuario = await db.query(
            `SELECT fichas, total_recargado, ganancias_congeladas
             FROM usuarios
             WHERE id = $1`,
            [usuarioId]
        );

        res.json({
            success: true,
            nuevas_fichas: nuevoUsuario.rows[0].fichas,
            total_recargado: nuevoUsuario.rows[0].total_recargado,
            ganancias_congeladas: nuevoUsuario.rows[0].ganancias_congeladas,
            ganancia
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en jugada:', error);
        res.status(500).json({
            error: error.message || 'Error en el servidor'
        });

    } finally {
        client.release();
    }
});

// SOLICITAR COBRO
router.post('/solicitar-cobro', verificarToken, async (req, res) => {
    const usuarioId = req.usuario.id;

    try {
        const usuario = await db.query(
            `SELECT fichas, total_recargado, ganancias_congeladas
             FROM usuarios
             WHERE id = $1`,
            [usuarioId]
        );

        const datos = usuario.rows[0];

        const inversion = Number(datos.total_recargado || 0);
        const fichas = Number(datos.fichas || 0);
        const congeladas = Number(datos.ganancias_congeladas || 0);

        const gananciasSesion = fichas > inversion ? fichas - inversion : 0;
        const aPagar = congeladas + gananciasSesion;

        if (aPagar <= 0) {
            return res.status(400).json({
                error: 'No tenés ganancias para cobrar'
            });
        }

        await db.query(
            `INSERT INTO solicitudes_cobro
             (usuario_id, monto, estado, fecha_solicitud)
             VALUES ($1, $2, 'pendiente', NOW())`,
            [usuarioId, aPagar]
        );

        res.json({
            success: true,
            mensaje: 'Solicitud enviada'
        });

    } catch (error) {
        console.error('Error al solicitar cobro:', error);
        res.status(500).json({
            error: 'Error al solicitar cobro'
        });
    }
});

// HISTORIAL
router.get('/historial', verificarToken, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT *
             FROM historial_juego
             WHERE usuario_id = $1
             ORDER BY fecha DESC
             LIMIT 50`,
            [req.usuario.id]
        );

        res.json(result.rows);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: 'Error en el servidor'
        });
    }
});

// ESTADÍSTICAS
router.get('/estadisticas', verificarToken, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT
                COUNT(*) as total_jugadas,
                SUM(CASE WHEN ganancia > 0 THEN 1 ELSE 0 END) as victorias,
                COALESCE(SUM(ganancia), 0) as ganancias_totales,
                COALESCE(MAX(ganancia), 0) as mayor_premio,
                COALESCE(AVG(ganancia), 0) as promedio_premio
             FROM historial_juego
             WHERE usuario_id = $1`,
            [req.usuario.id]
        );

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: 'Error en el servidor'
        });
    }
});

module.exports = router;
