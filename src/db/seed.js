require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { initDb, getDb } = require('./schema');

async function seed() {
  await initDb();
  const db = getDb();

  console.log('🌱 Seeding...');

  await db.query(`
    TRUNCATE withdrawals, favorites, notifications, ratings, mission_reports,
    mission_messages, mission_media, missions, oeil_availability, oeil_profiles, users
    RESTART IDENTITY CASCADE
  `);

  const hash = (p) => bcrypt.hashSync(p, 10);
  const adminId   = uuidv4(), client1Id = uuidv4(), client2Id = uuidv4();
  const oeil1Id   = uuidv4(), oeil2Id   = uuidv4(), oeil3Id   = uuidv4();

  const ins = (sql, vals) => db.query(sql, vals);

  const userSQL = `INSERT INTO users (id,email,password,role,first_name,last_name,phone,city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
  await ins(userSQL, [adminId,   'admin@shoofly.ma',  hash('admin123'),  'admin',  'Soufiane','Admin',    '+212600000001','Rabat']);
  await ins(userSQL, [client1Id, 'karim@gmail.com',   hash('client123'), 'client', 'Karim',   'Benali',   '+212661234567','Rabat']);
  await ins(userSQL, [client2Id, 'sara@gmail.com',    hash('client123'), 'client', 'Sara',    'Moussaoui','+212662345678','Casablanca']);
  await ins(userSQL, [oeil1Id,   'yassine@gmail.com', hash('oeil123'),   'oeil',   'Yassine', 'Bensouda', '+212655111222','Rabat']);
  await ins(userSQL, [oeil2Id,   'houda@gmail.com',   hash('oeil123'),   'oeil',   'Houda',   'Moussaoui','+212655333444','Rabat']);
  await ins(userSQL, [oeil3Id,   'karimt@gmail.com',  hash('oeil123'),   'oeil',   'Karim',   'Tahiri',   '+212655555666','Salé']);

  const profSQL = `INSERT INTO oeil_profiles (user_id,bio,coverage_zone,is_verified,rating_avg,rating_count,total_missions,total_earnings,balance) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  await ins(profSQL, [oeil1Id,'Spécialisé visites immobilières.','Rabat, Agdal',true,4.9,47,47,9400,1850]);
  await ins(profSQL, [oeil2Id,'Files d\'attente et démarches admin.','Rabat, Salé',true,5.0,31,31,6200,920]);
  await ins(profSQL, [oeil3Id,'Audit et mystery shopping.','Salé, Témara',true,4.8,28,28,5600,1100]);

  for (const uid of [oeil1Id,oeil2Id,oeil3Id]) {
    for (let d=0;d<=5;d++) await ins(`INSERT INTO oeil_availability (user_id,day_of_week,start_time,end_time) VALUES ($1,$2,$3,$4)`,[uid,d,'08:00','20:00']);
  }

  const m1=uuidv4(),m2=uuidv4(),m3=uuidv4(),m4=uuidv4(),m5=uuidv4();

  await ins(`INSERT INTO missions (id,client_id,oeil_id,type,status,title,description,address,city,scheduled_at,duration_est,price,commission,oeil_earning,is_urgent,property_type,visit_type,video_call,assigned_at,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [m1,client1Id,oeil1Id,'immobilier','active','Visite appartement Agdal','Vérifier état général, photos chaque pièce','Rue Ibn Batouta, Agdal','Rabat',new Date(),90,200,40,160,true,'Appartement','Avant location',true,new Date(Date.now()-3600000),new Date(Date.now()-1800000)]);

  await ins(`INSERT INTO missions (id,client_id,oeil_id,type,status,title,description,address,city,scheduled_at,duration_est,price,commission,oeil_earning,is_urgent,institution,purpose,assigned_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [m2,client1Id,oeil2Id,'file_attente','assigned','File CNSS Hay Riad','Dépôt dossier retraite guichet 3','Bvd Mehdi Ben Barka, Hay Riad','Rabat',new Date(),180,150,30,120,false,'CNSS','Dépôt dossier retraite',new Date(Date.now()-7200000)]);

  await ins(`INSERT INTO missions (id,client_id,oeil_id,type,status,title,address,city,scheduled_at,price,commission,oeil_earning,company_name,audit_type,assigned_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [m3,client1Id,oeil3Id,'audit','completed','Audit Méga Mall','Méga Mall, Hay Riad','Rabat',new Date(Date.now()-86400000),450,90,360,'Méga Mall','Mystery shopping',new Date(Date.now()-90000000),new Date(Date.now()-82800000)]);

  await ins(`INSERT INTO missions (id,client_id,oeil_id,type,status,title,address,city,scheduled_at,price,commission,oeil_earning,property_type,visit_type,assigned_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [m4,client2Id,oeil1Id,'immobilier','completed','État des lieux Souissi','Rue des Ambassadeurs, Souissi','Rabat',new Date(Date.now()-172800000),300,60,240,'Villa','État des lieux sortie',new Date(Date.now()-176400000),new Date(Date.now()-169200000)]);

  await ins(`INSERT INTO missions (id,client_id,type,status,title,description,address,city,scheduled_at,duration_est,price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [m5,client2Id,'personnalisee','pending','Accompagnement médical Ibn Sina','Accompagner mon père à la consultation','Hôpital Ibn Sina, Av. Ibn Sina','Rabat',new Date(Date.now()+86400000),180,180]);

  const msgSQL = `INSERT INTO mission_messages (mission_id,sender_id,content,type) VALUES ($1,$2,$3,$4)`;
  await ins(msgSQL,[m1,client1Id,'Bonjour ! Vous êtes bien arrivé ?','text']);
  await ins(msgSQL,[m1,oeil1Id,'Oui je suis devant l\'immeuble, je monte.','text']);
  await ins(msgSQL,[m1,client1Id,'Vérifiez la cuisine en priorité.','text']);
  await ins(msgSQL,[m1,oeil1Id,'Bien sûr, photos dans 2 minutes.','text']);
  await ins(msgSQL,[m1,oeil1Id,'Mission démarrée','system']);

  await ins(`INSERT INTO mission_reports (mission_id,summary,risk_points,score,created_by) VALUES ($1,$2,$3,$4,$5)`,
    [m3,'Accueil correct, délai service long (8 min). Propreté satisfaisante.',JSON.stringify(['Temps service > 5 min','Stock limité rayon B']),74,oeil3Id]);

  await ins(`INSERT INTO ratings (mission_id,client_id,oeil_id,score,comment) VALUES ($1,$2,$3,$4,$5)`,[m3,client1Id,oeil3Id,5,'Excellent, rapport très détaillé !']);
  await ins(`INSERT INTO ratings (mission_id,client_id,oeil_id,score,comment) VALUES ($1,$2,$3,$4,$5)`,[m4,client2Id,oeil1Id,5,'Ponctuel et professionnel.']);

  await ins(`INSERT INTO favorites (client_id,oeil_id) VALUES ($1,$2)`,[client1Id,oeil1Id]);
  await ins(`INSERT INTO favorites (client_id,oeil_id) VALUES ($1,$2)`,[client1Id,oeil2Id]);

  const notifSQL = `INSERT INTO notifications (user_id,title,body,type,mission_id) VALUES ($1,$2,$3,$4,$5)`;
  await ins(notifSQL,[client1Id,'Œil assigné','Yassine B. a accepté votre mission Agdal','mission',m1]);
  await ins(notifSQL,[client1Id,'3 photos reçues','Votre Œil a envoyé des médias','media',m1]);
  await ins(notifSQL,[oeil1Id,'Nouvelle mission disponible','Visite villa Souissi — 200 MAD · Urgent','mission',null]);

  await ins(`INSERT INTO withdrawals (oeil_id,amount,bank_info) VALUES ($1,$2,$3)`,[oeil1Id,1850,JSON.stringify({bank:'CIH Bank',rib:'MA64 0000 0000 0000 0000 0000'})]);

  console.log('✅ Seed complet!\n');
  console.log('📋 Comptes de test:');
  console.log('  Admin  → admin@shoofly.ma   / admin123');
  console.log('  Client → karim@gmail.com    / client123');
  console.log('  Client → sara@gmail.com     / client123');
  console.log('  Œil    → yassine@gmail.com  / oeil123');
  console.log('  Œil    → houda@gmail.com    / oeil123');
  console.log('  Œil    → karimt@gmail.com   / oeil123');
  await db.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
