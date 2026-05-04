# Ayran CsDrive WebHost WebApp

I want to create a full stack react app with nextJs. Let's first create the backend (the backend should be served from the same origin as the frontend): provide a way for the user to authenticate to one (or multiple) google account(s) requesting full permissions for google drive. Then simply forward all operations exposed by google drive api to the client (of course by hiding away the client secret and client id). The backend should leave have a way to be able to authenticate to other cloud storage providers (for the future).
