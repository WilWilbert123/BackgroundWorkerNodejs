require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const mssql = require('mssql');
const fs = require('fs');

// Write the Process ID (PID) to a file so our stop script can find it
fs.writeFileSync('worker.pid', process.pid.toString());

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Parse MSSQL server and instance name
let dbServer = process.env.MSSQL_SERVER;
let dbInstance = undefined;
if (dbServer.includes('\\')) {
  const parts = dbServer.split('\\');
  dbServer = parts[0];
  dbInstance = parts[1];
}

// MSSQL Configuration
const sqlConfig = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: process.env.MSSQL_DATABASE,
  server: dbServer,
  port: process.env.MSSQL_PORT ? parseInt(process.env.MSSQL_PORT, 10) : 1433,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: false, // Set to true if on Azure
    trustServerCertificate: true, // Essential for local dev with self-signed certs
  }
};

if (dbInstance) {
  sqlConfig.options.instanceName = dbInstance;
}

let pool;

/**
 * Connect to MSSQL Database
 */
async function connectToDatabase() {
  try {
    pool = await mssql.connect(sqlConfig);
    console.log('[MSSQL] Successfully connected to database.');
  } catch (err) {
    console.error('[MSSQL] Database connection failed:', err);
    process.exit(1);
  }
}

/**
 * Helper function to dynamically insert a row into an MSSQL table.
 * It ignores nested objects (which are Supabase relations).
 */
async function insertRow(transaction, tableName, rowData) {
  const request = new mssql.Request(transaction);
  const columns = [];

  // List of columns that are IDENTITY in MSSQL. We must omit them so MSSQL can auto-generate them.
  const identityColumns = ['HeaderID', 'DetailID', 'PaymentID', 'OrderID'];

  for (const [col, val] of Object.entries(rowData)) {
    // Skip nested objects/arrays (these represent Supabase child relations)
    if (typeof val === 'object' && val !== null && !(val instanceof Date)) {
      continue;
    }

    // Skip identity columns
    if (identityColumns.includes(col)) {
      continue;
    }

    columns.push(`[${col}]`); // Escape column names to prevent SQL keyword conflicts
    request.input(col, val);
  }

  if (columns.length === 0) return;

  const placeholders = columns.map(col => `@${col.replace(/[\[\]]/g, '')}`).join(', ');
  const query = `INSERT INTO [${tableName}] (${columns.join(', ')}) VALUES (${placeholders})`;

  await request.query(query);
}

/**
 * Synchronize a single order and its children from Supabase to MSSQL
 */
async function syncOrder(orderCode) {
  console.log(`[SYNC INIT] Fetching complete order data from Supabase for OrderCode: ${orderCode}`);

  try {
    // 1. Fetch complete parent-child object structure from Supabase
    const { data: order, error } = await supabase
      .from('tblOrderHeader')
      .select(`
        *,
        tblOrderDetails (*),
        tblOrderDiscDetail (*),
        tblOrderPayment (*)
      `)
      .eq('OrderCode', orderCode)
      .single();

    if (error || !order) {
      console.error(`[SYNC ERROR] OrderCode: ${orderCode} not found in Supabase or fetch error occurred:`, error?.message || 'Not found');
      return;
    }

    // 2. Begin Explicit MSSQL Transaction
    const transaction = new mssql.Transaction(pool);
    await transaction.begin();

    try {
      // 3. Deduplication Check
      const checkRequest = new mssql.Request(transaction);
      checkRequest.input('checkOrderCode', orderCode);
      const checkResult = await checkRequest.query('SELECT 1 FROM [tblOrderHeader] WHERE [OrderCode] = @checkOrderCode');

      if (checkResult.recordset.length > 0) {
        console.log(`[SYNC SKIP] OrderCode: ${orderCode} already exists in MSSQL. Preventing duplicate insertion.`);
        await transaction.rollback();
        return;
      }

      // 4. Step A: Insert Header
      await insertRow(transaction, 'tblOrderHeader', order);

      // 5. Step B: Insert Details
      if (order.tblOrderDetails && order.tblOrderDetails.length > 0) {
        for (const detail of order.tblOrderDetails) {
          await insertRow(transaction, 'tblOrderDetails', detail);
        }
      }

      // 6. Step C: Insert Discount Details (if data exists)
      if (order.tblOrderDiscDetail && order.tblOrderDiscDetail.length > 0) {
        for (const discDetail of order.tblOrderDiscDetail) {
          await insertRow(transaction, 'tblOrderDiscDetail', discDetail);
        }
      }

      // 7. Step D: Insert Payments
      if (order.tblOrderPayment && order.tblOrderPayment.length > 0) {
        for (const payment of order.tblOrderPayment) {
          await insertRow(transaction, 'tblOrderPayment', payment);
        }
      }

      // 8. Commit the transaction if all steps succeed
      await transaction.commit();
      console.log(`[SYNC SUCCESS] OrderCode: ${orderCode} completely synced to MSSQL.`);

      // 9. Update Supabase to mark as saved
      const { error: updateErr } = await supabase
        .from('tblOrderHeader')
        .update({ is_saved: true })
        .eq('OrderCode', orderCode);

      if (updateErr) {
        console.error(`[SUPABASE UPDATE ERROR] Failed to mark OrderCode: ${orderCode} as saved.`, updateErr);
      }
    } catch (txErr) {
      console.error(`[SYNC TRANSACTION ERROR] OrderCode: ${orderCode}. Rolling back transaction...`, txErr);
      await transaction.rollback();
    }

  } catch (err) {
    console.error(`[SYNC FATAL ERROR] Unhandled exception syncing OrderCode: ${orderCode}`, err);
  }
}

/**
 * Perform an initial fetch of existing orders in Supabase
 * to catch up any that haven't been synced to MSSQL yet.
 */
async function initialSync() {
  // Silent check without spamming the console too much
  try {
    const { data: orders, error } = await supabase
      .from('tblOrderHeader')
      .select('OrderCode')
      .order('OrderDateCreated', { ascending: false })
      .order('OrderTimeCreated', { ascending: false })
      .limit(300); // Only check the latest 300 orders to be extremely fast

    if (error) {
      console.error('[AUTO SYNC ERROR] Failed to fetch existing orders:', error);
      return;
    }

    if (orders && orders.length > 0) {
      for (const order of orders) {
        if (order.OrderCode) {
          // syncOrder has a built-in deduplication check, so it will silently skip ones already in MSSQL
          // and only insert the ones that are actually missing!
          await syncOrder(order.OrderCode);
        }
      }
    }
  } catch (err) {
    console.error('[AUTO SYNC FATAL ERROR]', err);
  }
}

/**
 * Start the background worker
 */
async function startWorker() {
  await connectToDatabase();

  console.log('[AUTO SYNC] Performing startup scan for missed data...');
  // 1. Sync all existing data that is currently in Supabase right on startup
  await initialSync();

  // 2. Set up an automatic safety net! 
  // Automatically run the check every 10 minutes (600,000 milliseconds)
  // This guarantees that if the internet dies, it will ALWAYS automatically fix itself.
  setInterval(() => {
    initialSync();
  }, 600000);

  // 3. Start listening for any brand new orders inserted from now on
  console.log('[SUPABASE] Subscribing to realtime inserts on tblOrderHeader...');

  // Realtime Detection / Hybrid Polling approach
  supabase
    .channel('public:tblOrderHeader')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tblOrderHeader' }, payload => {
      const newOrder = payload.new;
      if (newOrder && newOrder.OrderCode) {
        console.log(`[REALTIME DETECTED] New order inserted in Supabase: ${newOrder.OrderCode}`);

        // Wait 2.5 seconds before syncing to ensure any client-side batch inserts
        // for child tables (details, payments) are fully committed to Supabase.
        setTimeout(() => {
          syncOrder(newOrder.OrderCode);
        }, 2500);
      }
    })
    .subscribe((status) => {
      console.log(`[SUPABASE] Subscription status: ${status}`);
    });
}

// Global error handlers to keep the background process running without crashing
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] Caught exception, worker remains running:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION] Caught rejection, worker remains running:', err);
});

startWorker();
