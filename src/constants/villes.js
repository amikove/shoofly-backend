// Liste canonique des villes et quartiers (Maroc) — copie serveur de la source de vérité
// frontend (shoofly-react/src/constants/villes.js). Dette technique : dupliquée manuellement,
// pas de package partagé entre les deux repos pour l'instant — si ce fichier est modifié,
// répercuter le changement côté frontend (et inversement).
const VILLES = {
  'Rabat': ['Agdal','Hassan','Souissi','Hay Riad','Océan','Aviation','Youssoufia','Akkari','Diour Jamaa','Médina','Orangers','Centre Ville','Hay Nahda','Takaddoum','Quartier Administratif','Mabella','Hay Al Matar','Les Orangers','Cité Universitaire','Prestigia'],
  'Salé': ['Bettana','Hay Salam','Tabriquet','Médina','Sidi Moussa','Bab Lamrissa','Hay Karima','Hay Arrahma','Layayda','Hssaine','Sala Al Jadida','Moulay Smaïl','Karia','Sidi Bouknadel','Mazma','Chemmaou','Said Hajji'],
  'Témara': ['Massira 1','Massira 2','Massira 3','Centre','Hay Al Fath','Hay Al Amal','Hay Ennour','Hay Nakhil','Hay Wifaq','Ouled Mtaa','Harhoura','Ain Attig','El Menzeh','Sidi Yahya Zaer','Guiche Oudaya','Hay Sadate','Hay Farah'],
  'Casablanca': ['Maarif','Bourgogne','Gauthier','Racine','Palmier','Belvédère','Roches Noires','Hay Hassani','Oulfa','Ain Chock','Sidi Maarouf','Californie','Polo','CIL','Ain Sebaa','Anfa','Sidi Belyout','Médina','Derb Sultan','Hay Mohammadi','Sidi Moumen','Bernoussi','Sbata',"Ben M'sick",'Moulay Rachid','Sidi Othmane','Lissasfa','Val Fleuri','Riviera','Inara','Nassim','Bouskoura','Dar Bouazza','Tit Mellil','Zenata','Lahraouiyine','El Hank'],
  'Marrakech': ['Guéliz','Hivernage','Médina','Mellah','Daoudiate','Massira',"M'hamid",'Targa','Azzouzia','Palmeraie','Sidi Youssef Ben Ali','Bab Doukkala','Ménara','Tamansourt','Iziki','Hay Hassani','Hay Mohammadi','Semlalia','Sidi Abbad','Amerchich','Kasbah','Riad Zitoun'],
  'Fès': ['Fès El Bali (Médina)','Ville Nouvelle','Fès Jdid','Saïss','Narjiss','Bensouda','Aouinat Hajjaj','Zouagha','Atlas','Agdal','Sidi Brahim','Dokkarat','Oued Fès','Ain Kadous','Hay Tarik','Zghouri',"Route d'Imouzzer",'Champ de Course'],
  'Meknès': ['Hamria','Médina','Ismaïlia','Marjane','Bassatine','Borj Moulay Omar','Riad','Hay Zitoune','Ain Smen','Plaza','Sidi Baba','Ouislane','Toulal','Sidi Bouzekri','Hay Mansour',"Bni M'hamed"],
  'Tanger': ['Médina','Malabata','Marshan','Mesnana','Iberia','California','Achakar','Boukhalef','Bni Makada','Dradeb','Ain Ktiouet','Moujahidine','Val Fleuri','Souani','Branes','Charf','Tanger City Center','Gzenaya','Mghogha','Casabarata','Playa','Jirari','Plaza Toro'],
  'Agadir': ['Talborjt','Centre Ville','Founty','Cité Suisse','Dakhla','Hay Mohammadi','Charaf','Bensergao','Anza','Tilila','Hay Salam','Tikiouine','Adrar','Aourir','Inezgane','Aït Melloul','Dcheira El Jihadia','Les Amicales'],
  'Oujda': ['Médina','Lazaret','Sidi Maâfa','Hay Al Qods','Isly','Quartier Universitaire','Hay Salam','Sidi Ziane','Hay Andalous','Mir Ali','Route de Berkane','Hay Chouhada','Colline','Gara'],
  'Kénitra': ['Centre Ville','Médina','Bir Rami','Saknia','Maamoura','Mimosa','Val Fleuri','La Ville Haute','Ouled Oujih','Alliance','Mehdia','Khabat','Al Ismaïlia'],
  'Tétouan': ['Médina',"Ensanche (M'stahan)",'Mhannech','Touabel','Dersa','Sidi Mandri','Kwilma','Boujarrah','Coelma','Barrio Málaga','Martil','Cabo Negro',"M'diq"],
  'Mohammedia': ['Centre Ville','Kasbah','La Siesta','Miramar','El Kantaoui','Rachidila','Hay El Falah','Hay El Massira','Hay El Hassania','Riyad','Béni Yakhlef','Ain Harrouda'],
  'El Jadida': ['Médina / Cité Portugaise','Centre Ville','Sidi Bouzid','Hay Matar','Hay Essalam','Plage','Hay Moulay Abdallah','Koudia','Najd','Mazagan'],
  'Safi': ['Médina','Centre Ville','Jrifat','Biada','Kourat','Hay Anas','Sidi Bouzid','Plateau','Zouhour','Saada','Sania'],
  'Béni Mellal': ['Centre Ville','Médina','Ain Asserdoun','Hay Al Qods','Hay El Houda','Amria','Hay Tasra','Oulad Hamdane','Hay Ouled Mohand'],
  'Nador': ['Centre Ville','Médina','Nador El Jadid','Jaadar','Aaroui','Beni Ensar','Zeghanghane','Selouane'],
  'Settat': ['Centre Ville','Hay Maimouna','Hay El Farha','Hay El Moustakbal','Hay Al Qods','Sidi Abdelkrim','Quartier Industriel'],
  'Laâyoune': ['Centre Ville','Hay El Aouda','Hay Moulay Rachid','Hay Al Qods','Hay El Amal','Place Dchira','Cité Militaire','Hay Al Massira'],
};

const VILLES_LIST = Object.keys(VILLES);

// Index insensible à la casse : "rabat" / "RABAT" → "Rabat" (clé canonique).
const CITY_BY_LOWER = new Map(VILLES_LIST.map(v => [v.toLowerCase(), v]));

// Résout une ville saisie (n'importe quelle casse) vers sa forme canonique, ou null si invalide.
function resolveCity(input) {
  if (typeof input !== 'string') return null;
  return CITY_BY_LOWER.get(input.trim().toLowerCase()) || null;
}

// Vérifie qu'un quartier appartient bien à la ville donnée (comparaison insensible à la casse).
// `city` doit déjà être la forme canonique (résolue via resolveCity).
function isValidQuartier(city, quartier) {
  if (typeof quartier !== 'string') return false;
  const list = VILLES[city];
  if (!list) return false;
  const target = quartier.trim().toLowerCase();
  return list.some(q => q.toLowerCase() === target);
}

// Résout un quartier saisi vers sa forme canonique pour la ville donnée, ou null si invalide.
function resolveQuartier(city, quartier) {
  if (typeof quartier !== 'string') return null;
  const list = VILLES[city];
  if (!list) return null;
  const target = quartier.trim().toLowerCase();
  return list.find(q => q.toLowerCase() === target) || null;
}

module.exports = { VILLES, VILLES_LIST, resolveCity, isValidQuartier, resolveQuartier };
