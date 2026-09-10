# Adding a React app

## Creating the React app

cd to the solution `src` directory and run the following command to create a new React app using Vite and Typescript:
```
npm create vite@latest frontend-react -- --template react-ts
```

Select `ESLint` as the linter when prompted, then select "Yes" to install. This will create a new React app in the `frontend-react` directory.

Add the following package to the AppHost project:
```
Aspire.Hosting.JavaScript
```

Add the following code to `AppHost.cs` to serve the React app:
```csharp
builder.AddViteApp("frontend-react", "../frontend-react")
    .WithNpm()
    .WithReference(python)
    .WaitFor(python);
```

## References


- [Going Full-Stack with .NET and Aspire](https://juliocasal.com/blog/going-full-stack-with-dotnet-aspire)
- [Building a Full-Stack App with React and Aspire: A Step-by-Step Guide | Build the React front-end](https://devblogs.microsoft.com/dotnet/new-aspire-app-with-react/#build-the-react-front-end)
- []()

	

