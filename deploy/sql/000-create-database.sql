SELECT format('CREATE ROLE gitsync WITH LOGIN PASSWORD %L', :'gitsync_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gitsync')\gexec

SELECT 'CREATE DATABASE gitsync OWNER gitsync'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gitsync')\gexec
