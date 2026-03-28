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

        // Asegurar que ganancias_congeladas exista (default 0)
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

        if (isNaN(fichas) || isNaN(monto) || isNaN(usuarioId)) {
            throw new Error(`Datos inválidos: fichas=${fichas}, monto=${monto}, usuarioId=${usuarioId}`);
        }

        // Obtener datos actuales del usuario para congelar ganancias
        const usuario = await client.query(
            'SELECT fichas, total_recargado, ganancias_congeladas FROM usuarios WHERE id = $1 FOR UPDATE',
            [usuarioId]
        );

        const inversion = usuario.rows[0].total_recargado || 0;
        const gananciasSesion = usuario.rows[0].fichas > inversion ? usuario.rows[0].fichas - inversion : 0;
        
        // Sumar ganancias de la sesión actual a las congeladas
        const nuevasGananciasCongeladas = (usuario.rows[0].ganancias_congeladas || 0) + gananciasSesion;

        console.log(`💰 Congelando ganancias: sesión=${gananciasSesion}, total congelado=${nuevasGananciasCongeladas}`);

        console.log(`💰 Agregando ${fichas} monedas a usuario ${usuarioId}`);

        // Marcar solicitud como aprobada
        await client.query(
            `UPDATE solicitudes_recarga 
             SET estado = 'aprobada', fecha_resolucion = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [solicitud_id]
        );

        // Actualizar usuario: agregar fichas, actualizar inversión, y actualizar ganancias congeladas
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
        } catch (transError) {
            console.log('⚠️ Tabla transacciones no existe, continuando...');
        }

        await client.query('COMMIT');
        
        console.log('✅ Recarga aprobada exitosamente');
        res.json({ success: true, message: `Agregadas ${fichas} monedas` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error en aprobar recarga:', error.message);
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

        // Obtener datos actuales del usuario para congelar ganancias
        const usuario = await client.query(
            'SELECT fichas, total_recargado, ganancias_congeladas FROM usuarios WHERE id = $1 FOR UPDATE',
            [usuario_id]
        );

        const inversion = usuario.rows[0].total_recargado || 0;
        const gananciasSesion = usuario.rows[0].fichas > inversion ? usuario.rows[0].fichas - inversion : 0;
        
        // Sumar ganancias de la sesión actual a las congeladas
        const nuevasGananciasCongeladas = (usuario.rows[0].ganancias_congeladas || 0) + gananciasSesion;

        await client.query(
            `UPDATE usuarios 
             SET fichas = fichas + $1, 
                 ganancias_congeladas = $2
             WHERE id = $3`,
            [fichas, nuevasGananciasCongeladas, usuario_id]
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
                (SELECT COUNT(*) FROM solicitudes_recarga WHERE estado = 'pendiente') as solicitudes_pendientes,
                (SELECT COUNT(*) FROM solicitudes_cobro WHERE estado = 'pendiente') as cobros_pendientes`
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

        const totales = await db.query(`
            SELECT 
                COUNT(*) as total_recargas,
                COALESCE(SUM(fichas), 0) as total_fichas,
                COALESCE(SUM(monto), 0) as total_monto
            FROM solicitudes_recarga
            WHERE estado = 'aprobada'
                AND fecha_solicitud >= CURRENT_DATE - INTERVAL '30 days'
        `);

        const diaPico = porDia.rows.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porDia.rows[0] || { dia: 'Sin datos', total_compras: 0 });

        const horaPico = porHora.rows.reduce((max, item) => 
            item.total_compras > max.total_compras ? item : max
        , porHora.rows[0] || { hora: 0, total_compras: 0 });

        const traduccionDias = {
            'Monday': 'Lunes', 'Tuesday': 'Martes', 'Wednesday': 'Miércoles',
            'Thursday': 'Jueves', 'Friday': 'Viernes', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
        };

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

// CONFIGURAR LÍMITE (solo admin)
router.post('/configurar-limite', async (req, res) => {
    try {
        const { limite } = req.body;
        
        if (!limite || limite < 1000 || limite > 1000000) {
            return res.status(400).json({ 
                success: false, 
                error: 'Límite inválido (mínimo 1000, máximo 1.000.000)' 
            });
        }
        
        await db.query(
            `INSERT INTO configuracion (clave, valor, actualizado_por, fecha_actualizacion)
             VALUES ('limite_premio', $1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (clave) DO UPDATE SET 
                valor = EXCLUDED.valor,
                actualizado_por = EXCLUDED.actualizado_por,
                fecha_actualizacion = CURRENT_TIMESTAMP`,
            [limite.toString(), req.usuario.id]
        );
        
        console.log(`🔒 Límite actualizado por admin ID ${req.usuario.id}: ₲ ${limite}`);
        
        res.json({ success: true, limite });
        
    } catch (error) {
        console.error('Error configurando límite:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ============================================
// OBTENER HISTORIAL DE UN USUARIO (CON SALDO ACTUAL E INVERSIÓN)
// ============================================
router.get('/historial-usuario/:usuarioId', verificarToken, verificarAdmin, async (req, res) => {
    try {
        const { usuarioId } = req.params;
        
        console.log(`📜 Obteniendo historial del usuario ${usuarioId}`);
        
        // Obtener datos del usuario (inversión y saldo actual)
        const usuario = await db.query(
            `SELECT total_recargado, fichas, ganancias_congeladas FROM usuarios WHERE id = $1`,
            [usuarioId]
        );
        
        const inversionTotal = usuario.rows[0]?.total_recargado || 0;
        const saldoActual = usuario.rows[0]?.fichas || 0;
        const gananciasCongeladas = usuario.rows[0]?.ganancias_congeladas || 0;
        
        // Calcular ganancias de sesión
        const gananciasSesion = saldoActual > inversionTotal ? saldoActual - inversionTotal : 0;
        const aPagar = gananciasCongeladas + gananciasSesion;
        
        // Obtener historial de jugadas
        const historial = await db.query(
            `SELECT id, apuesta, ganancia, combinacion, fecha 
             FROM historial_juego 
             WHERE usuario_id = $1 
             ORDER BY fecha DESC 
             LIMIT 100`,
            [usuarioId]
        );
        
        // Obtener estadísticas del usuario
        const stats = await db.query(
            `SELECT 
                COUNT(*) as total_jugadas,
                SUM(CASE WHEN ganancia > 0 THEN 1 ELSE 0 END) as victorias,
                COALESCE(SUM(ganancia), 0) as ganancias_totales
             FROM historial_juego
             WHERE usuario_id = $1`,
            [usuarioId]
        );
        
        res.json({
            historial: historial.rows,
            stats: {
                ...stats.rows[0],
                inversion_total: inversionTotal,
                saldo_actual: saldoActual,
                ganancias_congeladas: gananciasCongeladas,
                a_pagar: aPagar
            }
        });
        
    } catch (error) {
        console.error('❌ Error obteniendo historial:', error);
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

// ============================================
// SOLICITUDES DE COBRO
// ============================================

// OBTENER SOLICITUDES DE COBRO PENDIENTES
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
        console.error('Error cargando solicitudes de cobro:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// APROBAR COBRO
router.post('/aprobar-cobro', async (req, res) => {
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        const { solicitud_id } = req.body;

        console.log('💰 Aprobando cobro ID:', solicitud_id);

        // Obtener solicitud
        const solicitud = await client.query(
            `SELECT * FROM solicitudes_cobro 
             WHERE id = $1 AND estado = 'pendiente' 
             FOR UPDATE`,
            [solicitud_id]
        );

        if (solicitud.rows.length === 0) {
            throw new Error('Solicitud no encontrada o ya procesada');
        }

        const solicitudData = solicitud.rows[0];
        const montoCobro = Number(solicitudData.monto);
        const usuarioId = Number(solicitudData.usuario_id);

        // Obtener datos del usuario
        const usuario = await client.query(
            'SELECT fichas, total_recargado, ganancias_congeladas FROM usuarios WHERE id = $1 FOR UPDATE',
            [usuarioId]
        );

        const inversion = usuario.rows[0].total_recargado || 0;
        const gananciasSesion = usuario.rows[0].fichas > inversion ? usuario.rows[0].fichas - inversion : 0;
        let nuevasGananciasCongeladas = (usuario.rows[0].ganancias_congeladas || 0) + gananciasSesion;
        let nuevoSaldo = usuario.rows[0].fichas;

        console.log(`💰 Usuario: saldo=${nuevoSaldo}, inversion=${inversion}, congeladas=${usuario.rows[0].ganancias_congeladas}, sesion=${gananciasSesion}, totalCongelado=${nuevasGananciasCongeladas}`);

        // Descontar el monto cobrado
        if (nuevasGananciasCongeladas >= montoCobro) {
            nuevasGananciasCongeladas -= montoCobro;
            console.log(`✅ Descontado de congeladas: nuevas congeladas=${nuevasGananciasCongeladas}`);
        } else {
            // Si no alcanza con las congeladas, descontar del saldo
            const resto = montoCobro - nuevasGananciasCongeladas;
            nuevoSaldo = nuevoSaldo - resto;
            nuevasGananciasCongeladas = 0;
            
            // Asegurar que el saldo no sea negativo
            if (nuevoSaldo < 0) nuevoSaldo = 0;
            
            console.log(`⚠️ No alcanzaban congeladas, descontando ${resto} del saldo. Nuevo saldo=${nuevoSaldo}`);
            
            await client.query(
                'UPDATE usuarios SET fichas = $1 WHERE id = $2',
                [nuevoSaldo, usuarioId]
            );
        }

        // Actualizar ganancias congeladas
        await client.query(
            'UPDATE usuarios SET ganancias_congeladas = $1 WHERE id = $2',
            [nuevasGananciasCongeladas, usuarioId]
        );

        // Marcar solicitud como aprobada
        await client.query(
            `UPDATE solicitudes_cobro 
             SET estado = 'aprobado', fecha_procesado = NOW() 
             WHERE id = $1`,
            [solicitud_id]
        );

        // Registrar transacción de cobro
        try {
            await client.query(
                `INSERT INTO transacciones (usuario_id, tipo, fichas, descripcion) 
                 VALUES ($1, 'cobro', $2, $3)`,
                [usuarioId, -montoCobro, `Cobro de ₲${montoCobro} aprobado por admin`]
            );
        } catch (transError) {
            console.log('⚠️ Tabla transacciones no existe, continuando...');
        }

        await client.query('COMMIT');
        
        console.log(`✅ Cobro de ₲${montoCobro} aprobado para usuario ${usuarioId}`);
        res.json({ success: true, message: `Cobro de ₲${montoCobro} aprobado` });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error aprobando cobro:', error.message);
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
             SET estado = 'rechazado', fecha_procesado = NOW() 
             WHERE id = $1 AND estado = 'pendiente'`,
            [solicitud_id]
        );

        res.json({ success: true });

    } catch (error) {
        console.error('Error rechazando cobro:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

module.exports = router;
