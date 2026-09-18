BOOKS GATE — MISE À JOUR V2

IMPORTANT
---------
NE REMPLACE PAS ton fichier config.js actuel.
Il contient déjà ton URL Supabase et ta clé publique qui fonctionnent.

FICHIERS À REMPLACER / AJOUTER SUR GITHUB
-----------------------------------------
Remplace :
- index.html
- group.html
- book.html
- admin.html
- styles.css
- common.js

Ajoute :
- admin-import.js

Ce que fait la V2
-----------------
- Connexion Admin
- Import d'un fichier .xlsx
- Reconnaissance automatique du format de ton book
- Lecture de : familles, libellé, EAN, rang, IFLS, TAN/TAC
- Extraction des photos intégrées dans la colonne VISUEL
- Les images de codes-barres de la colonne F ne sont PAS stockées
- Compression des photos en WebP avant envoi dans Supabase
- Réutilisation des produits grâce à l'EAN
- Publication du book seulement une fois l'import terminé
- Badge NOUVEAU pendant 7 jours
- Suppression d'un ancien book
- Nettoyage des produits/photos qui ne servent plus à aucun autre book

COMMENT METTRE À JOUR
---------------------
1. Décompresse ce ZIP.
2. Dans GitHub > dépôt books-gate > Add file > Upload files.
3. Envoie les 6 fichiers à remplacer + admin-import.js.
4. Si GitHub demande confirmation pour remplacer les fichiers existants, accepte.
5. NE TOUCHE PAS à config.js.
6. Commit changes.
7. Attends environ 1 à 2 minutes que GitHub Pages se mette à jour.
8. Ouvre Books Gate > Admin.
9. Choisis le fichier "Grignotage sucré salé TMB 70.xlsx".
10. Clique "Analyser le fichier".
11. Vérifie l'aperçu.
12. Clique "Publier le book".

POUR TON FICHIER TEST
---------------------
Le fichier contient 98 références.
La V2 doit détecter automatiquement les familles, les rangs et TAN/TAC.
Certaines références peuvent ne pas avoir de photo intégrée exploitable : elles seront publiées quand même avec un emplacement image vide.
